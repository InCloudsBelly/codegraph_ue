import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import type { Node } from '../src/types';

describe('Unreal native delegate flow through the public SDK', () => {
  let root: string;
  let graph: CodeGraph | undefined;
  const write = (name: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), source);
  };
  const compileEnvironment = (args: string[] = []) => write('compile_commands.json', JSON.stringify([{
    directory: root, file: 'Owner.cpp', arguments: ['clang++', ...args, '-I', root, '-c', 'Owner.cpp'],
  }]));
  const crossHeaderOwner = (include = '#include "Event.h"\n') => `
${include}class UOwner {
  FReady Ready;
public:
  void Handle() {}
  void Setup() { Ready.AddUObject(this, &UOwner::Handle); }
  void Dispatch() { Ready.Broadcast(); }
};
`;
  const delegateCallees = () => graph!.getOutgoingEdges(node('UOwner::Dispatch').id)
    .filter(edge => edge.metadata?.synthesizedBy === 'unreal-delegate');
  const node = (qualifiedName: string): Node => {
    const candidates = graph!.getNodesByQualifiedName(qualifiedName).filter(n => n.kind === 'method');
    expect(candidates, qualifiedName).toHaveLength(1);
    return candidates[0]!;
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-delegate-')); });
  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('cg-ue-delegate-')) {
      throw new Error('Refusing to remove a non-fixture directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it('connects Broadcast to an explicit UObject callback and its downstream call', async () => {
    write('Owner.cpp', `
DECLARE_MULTICAST_DELEGATE(FReady);
class UOwner {
  FReady Ready;
public:
  void Leaf() {}
  void Handle() { Leaf(); }
  void Setup() { Ready.AddUObject(this, &UOwner::Handle); }
  void Dispatch() { Ready.Broadcast(); }
};
`);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    const dispatch = node('UOwner::Dispatch');
    const handle = node('UOwner::Handle');
    const leaf = node('UOwner::Leaf');
    const edge = graph.getOutgoingEdges(dispatch.id).find(e => e.target === handle.id && e.metadata?.synthesizedBy === 'unreal-delegate');
    expect(edge).toMatchObject({ kind: 'calls', provenance: 'heuristic', line: 9 });
    expect(edge?.metadata).toMatchObject({ registeredAt: 'Owner.cpp:8', via: 'UOwner::Ready' });
    expect(graph.findPath(dispatch.id, leaf.id, ['calls'])?.map(step => step.node.qualifiedName))
      .toEqual(['UOwner::Dispatch', 'UOwner::Handle', 'UOwner::Leaf']);
  });

  it('bridges BindUObject with Execute and ExecuteIfBound without crossing sibling instances', async () => {
    write('Instances.cpp', `
DECLARE_DELEGATE(FReady);
class UEmitter { public: FReady Ready; };
class UListener {
public:
  void Leaf() {}
  void Handle() { Leaf(); }
  void OtherInstance(UEmitter& left, UEmitter& right) {
    left.Ready.BindUObject(this, &UListener::Handle);
    right.Ready.Execute();
  }
  void SameInstance(UEmitter& source) {
    source.Ready.BindUObject(this, &UListener::Handle);
    source.Ready.ExecuteIfBound();
  }
};
`);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    const edges = (name: string) => graph!.getOutgoingEdges(node(name).id).filter(e => e.metadata?.synthesizedBy === 'unreal-delegate');
    expect(edges('UListener::OtherInstance')).toHaveLength(0);
    expect(edges('UListener::SameInstance')).toHaveLength(1);
    expect(graph.findPath(node('UListener::SameInstance').id, node('UListener::Leaf').id, ['calls'])?.map(step => step.node.qualifiedName))
      .toEqual(['UListener::SameInstance', 'UListener::Handle', 'UListener::Leaf']);
  });

  it('does not join namesake fields, overloaded callbacks, non-delegates or text inside literals', async () => {
    write('Precision.cpp', `
DECLARE_MULTICAST_DELEGATE(FReady);
class UFirst {
  FReady Ready;
public:
  void Handle() {}
  void Setup() { Ready.AddUObject(this, &UFirst::Handle); }
};
class USecond {
  FReady Ready;
public:
  void WrongClassDispatch() { Ready.Broadcast(); }
};
class UOverload {
  FReady Ready;
public:
  void Handle(int value) {}
  void Handle(float value) {}
  void Setup() { Ready.AddUObject(this, &UOverload::Handle); }
  void OverloadedDispatch() { Ready.Broadcast(); }
};
class UFake {
  FNotADelegate Ready;
public:
  void Handle() {}
  void Setup() { Ready.AddUObject(this, &UFake::Handle); }
  void NonDelegateDispatch() { Ready.Broadcast(); }
};
class UText {
  FReady Ready;
public:
  void Handle() {}
  void Setup() {
    // Ready.AddUObject(this, &UText::Handle);
    const char* text = R"ue(Ready.AddUObject(this, &UText::Handle);)ue";
  }
  void LiteralDispatch() { Ready.Broadcast(); }
};
`);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    for (const name of ['USecond::WrongClassDispatch', 'UOverload::OverloadedDispatch', 'UFake::NonDelegateDispatch', 'UText::LiteralDispatch']) {
      expect(graph.getOutgoingEdges(node(name).id).filter(e => e.metadata?.synthesizedBy === 'unreal-delegate'), name).toHaveLength(0);
    }
  });

  it('recomputes wiring after a registration changes and disappears during sync', async () => {
    const source = (registration: string) => `
DECLARE_MULTICAST_DELEGATE(FReady);
class UOwner {
  FReady Ready;
public:
  void HandleAlpha() {}
  void HandleBeta() {}
  void Setup() { ${registration} }
  void Dispatch() { Ready.Broadcast(); }
};
`;
    const targets = () => graph!.getCallees(node('UOwner::Dispatch').id)
      .filter(({ edge }) => edge.metadata?.synthesizedBy === 'unreal-delegate').map(({ node: target }) => target.qualifiedName);
    write('Owner.cpp', source('Ready.AddUObject(this, &UOwner::HandleAlpha);'));
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    expect(targets()).toEqual(['UOwner::HandleAlpha']);
    write('Owner.cpp', source('Ready.AddUObject(this, &UOwner::HandleBeta);'));
    await graph.sync();
    expect(targets()).toEqual(['UOwner::HandleBeta']);
    write('Owner.cpp', source(''));
    await graph.sync();
    expect(targets()).toEqual([]);
  });

  it('does not guess through single-cast rebinding ambiguity or an instance reassignment', async () => {
    write('Ambiguity.cpp', `
DECLARE_DELEGATE(FReady);
class UEmitter { public: FReady Ready; };
class UListener {
public:
  void First() {}
  void Second() {}
  void Rebound(UEmitter& source) {
    source.Ready.BindUObject(this, &UListener::First);
    source.Ready.BindUObject(this, &UListener::Second);
    source.Ready.Execute();
  }
  void Changed(UEmitter* source, UEmitter* other) {
    source->Ready.BindUObject(this, &UListener::First);
    source = other;
    source->Ready.Execute();
  }
};
`);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    for (const name of ['UListener::Rebound', 'UListener::Changed']) {
      expect(graph.getOutgoingEdges(node(name).id).filter(e => e.metadata?.synthesizedBy === 'unreal-delegate'), name).toHaveLength(0);
    }
  });

  it('resolves a cross-header delegate field and the unique UFUNCTION implementation', async () => {
    compileEnvironment();
    write('Event.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Owner.h', `
#include "Event.h"
class UOwner {
  FReady Ready;
public:
  UFUNCTION()
  void Handle();
  void Leaf();
  void Setup();
  void Dispatch();
};
`);
    write('Owner.cpp', `
#include "Owner.h"
void UOwner::Leaf() {}
void UOwner::Handle() { Leaf(); }
void UOwner::Setup() { Ready.AddUObject(this, &UOwner::Handle); }
void UOwner::Dispatch() { Ready.Broadcast(); }
`);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    const callees = graph.getCallees(node('UOwner::Dispatch').id).filter(({ edge }) => edge.metadata?.synthesizedBy === 'unreal-delegate');
    expect(callees).toHaveLength(1);
    expect(callees[0]!.node.filePath).toBe('Owner.cpp');
    expect(graph.findPath(node('UOwner::Dispatch').id, node('UOwner::Leaf').id, ['calls'])?.map(step => step.node.qualifiedName))
      .toEqual(['UOwner::Dispatch', 'UOwner::Handle', 'UOwner::Leaf']);
  });

  it('resolves lexical namespace types but never borrows a delegate past a nearer forward declaration', async () => {
    write('Namespaces.cpp', `
DECLARE_MULTICAST_DELEGATE(FReady);
namespace Game {
DECLARE_MULTICAST_DELEGATE(FReady);
class UOwner {
  FReady Ready;
public:
  void Handle() {}
  void Setup() { Ready.AddUObject(this, &UOwner::Handle); }
  void Dispatch() { Ready.Broadcast(); }
};
}
namespace Wrong {
class FReady;
class UOwner {
  FReady Ready;
public:
  void Handle() {}
  void Setup() { Ready.AddUObject(this, &UOwner::Handle); }
  void Dispatch() { Ready.Broadcast(); }
};
}
`);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    const edges = (name: string) => graph!.getOutgoingEdges(node(name).id).filter(e => e.metadata?.synthesizedBy === 'unreal-delegate');
    expect(edges('Game::UOwner::Dispatch')).toHaveLength(1);
    expect(edges('Wrong::UOwner::Dispatch')).toHaveLength(0);
  });

  it('keeps the complete flow through indexAll and its compiled parse worker', async () => {
    write('Bulk.cpp', `
DECLARE_MULTICAST_DELEGATE(FReady);
class UBulk {
  FReady Ready;
public:
  void Leaf() {}
  void Handle() { Leaf(); }
  void Setup() { Ready.AddUObject(this, &UBulk::Handle); }
  void Dispatch() { Ready.Broadcast(); }
};
`);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.indexAll();
    const dispatch = node('UBulk::Dispatch');
    const handle = node('UBulk::Handle');
    expect(graph.getOutgoingEdges(dispatch.id).some(e => e.target === handle.id && e.metadata?.synthesizedBy === 'unreal-delegate')).toBe(true);
    expect(graph.findPath(dispatch.id, node('UBulk::Leaf').id, ['calls'])?.map(step => step.node.qualifiedName))
      .toEqual(['UBulk::Dispatch', 'UBulk::Handle', 'UBulk::Leaf']);
  });

  it('drops cross-header wiring when its actual owner include is removed during sync', async () => {
    compileEnvironment();
    write('Event.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Owner.h', crossHeaderOwner());
    write('Owner.cpp', '#include "Owner.h"\n');
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    expect(delegateCallees()).toHaveLength(1);
    write('Owner.h', crossHeaderOwner(''));
    await graph.sync();
    expect(delegateCallees()).toHaveLength(0);
  });

  it('never borrows a globally namesake delegate from an unrelated module', async () => {
    compileEnvironment();
    write('Unrelated/Events.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Owner.h', crossHeaderOwner(''));
    write('Owner.cpp', '#include "Owner.h"\n');
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    expect(delegateCallees()).toHaveLength(0);
  });

  it.each(['missing', 'incomplete'] as const)('rejects cross-header wiring with a %s include environment', async environment => {
    if (environment === 'incomplete') compileEnvironment(['-include', 'Forced.h']);
    write('Event.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Owner.h', crossHeaderOwner());
    write('Owner.cpp', '#include "Owner.h"\n');
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    expect(delegateCallees()).toHaveLength(0);
  });

  it('does not skip an excluded earlier include candidate to borrow a later delegate', async () => {
    compileEnvironment(['-I', path.join(root, 'Earlier'), '-I', path.join(root, 'Later')]);
    write('codegraph.json', JSON.stringify({ exclude: ['Earlier/**'] }));
    write('Earlier/Event.h', 'class FReady {};\n');
    write('Later/Event.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Owner.h', crossHeaderOwner());
    write('Owner.cpp', '#include "Owner.h"\n');
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    expect(delegateCallees()).toHaveLength(0);
  });

  it('keeps the actually included delegate when an unrelated module defines the same qualified name', async () => {
    compileEnvironment();
    write('Event.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Unrelated/Event.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Owner.h', crossHeaderOwner());
    write('Owner.cpp', '#include "Owner.h"\n');
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    expect(delegateCallees()).toHaveLength(1);
  });

  it('requires the same-file delegate declaration to precede its field', async () => {
    const declaration = 'DECLARE_MULTICAST_DELEGATE(FReady);\n';
    const owner = crossHeaderOwner('');
    write('Owner.cpp', declaration + owner);
    graph = await CodeGraph.init(root, { silent: true });
    await graph.sync();
    expect(delegateCallees()).toHaveLength(1);
    write('Owner.cpp', owner + declaration);
    await graph.sync();
    expect(delegateCallees()).toHaveLength(0);
  });
});
