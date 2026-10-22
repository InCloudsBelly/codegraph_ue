import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';

describe('Unreal reflected declarations', () => {
  let root: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-reflection-')); });
  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^cg-ue-reflection-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(file: string, text: string) {
    fs.writeFileSync(path.join(root, file), text);
    if (/\.cpp$/i.test(file)) fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(
      fs.readdirSync(root).filter(f => /\.cpp$/i.test(f)).map(f => ({ directory: root, file: path.join(root, f),
        arguments: ['clang++', '-I', root, '-c', path.join(root, f)] })),
    ));
  }

  it('persists reflected fields, callable declarations and delegate types without minting macro calls', async () => {
    write('License.h', `
DECLARE_MULTICAST_DELEGATE_OneParam(FOnChanged, int);
UCLASS(BlueprintType)
class ULicense : public UObject {
  GENERATED_BODY()
public:
  UPROPERTY(EditAnywhere, meta=(DisplayName="Bake asset"))
  TObjectPtr<UBakeAsset> BakeAsset;
  UFUNCTION(BlueprintCallable, Category="Bake")
  void Rebuild(int Count) const;
};
// UPROPERTY() int FakeComment;
const char* Example = "UFUNCTION() void FakeString();";
`);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    graph.destroy();
    graph = await CodeGraph.open(root);
    const field = graph.getNodesByName('BakeAsset').find(n => n.kind === 'field');
    expect(field).toMatchObject({ qualifiedName: 'ULicense::BakeAsset', language: 'cpp' });
    expect(field?.decorators).toContain('UPROPERTY(EditAnywhere, meta=(DisplayName="Bake asset"))');
    const declaration = graph.getNodesByName('Rebuild').find(n => n.filePath === 'License.h');
    expect(declaration).toMatchObject({ kind: 'method', qualifiedName: 'ULicense::Rebuild' });
    expect(declaration?.decorators).toContain('UFUNCTION(BlueprintCallable, Category="Bake")');
    expect(declaration?.signature).toBe('void Rebuild(int Count) const;');
    expect(graph.getNodesByName('ULicense')[0]?.decorators).toContain('UCLASS(BlueprintType)');
    expect(graph.getNodesByName('FOnChanged')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type_alias', decorators: ['DECLARE_MULTICAST_DELEGATE_OneParam(FOnChanged, int)'] }),
    ]));
    expect(graph.getNodesByName('FakeComment')).toEqual([]);
    expect(graph.getNodesByName('FakeString')).toEqual([]);
    expect(graph.getNodesByName('UPROPERTY').filter(n => n.kind === 'function')).toEqual([]);
  });

  it('links only the exact reflected declaration to its definition and keeps the callback downstream flow', async () => {
    write('License.h', `UCLASS()
class ULicense {
public:
 UFUNCTION() void Rebuild(int Count) const;
 UFUNCTION() void Rebuild(float Count) const;
};\n`);
    write('License.cpp', `#include "License.h"
void PersistBake() {}
void ULicense::Rebuild(int NewCount) const { PersistBake(); }
void ULicense::Rebuild(float NewCount) const {}
`);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    const declarations = graph.getNodesByName('Rebuild').filter(n => n.filePath === 'License.h');
    const definitions = graph.getNodesByName('Rebuild').filter(n => n.filePath === 'License.cpp');
    expect(declarations).toHaveLength(2);
    expect(definitions).toHaveLength(2);
    for (const declaration of declarations) {
      const callees = graph.getCallees(declaration.id);
      expect(callees).toHaveLength(1);
      expect(callees[0]!.node.startLine).toBe(declaration.signature?.includes('int Count') ? 3 : 4);
    }
    const intDecl = declarations.find(n => n.signature?.includes('int Count'))!;
    const intDefinition = graph.getCallees(intDecl.id)[0]!.node;
    expect(graph.getCallees(intDefinition.id).map(r => r.node.name)).toContain('PersistBake');
    write('License.cpp', '#include "License.h"\nvoid ULicense::Rebuild(double Count) const {}\n');
    await graph.sync();
    expect(graph.getCallees(intDecl.id)).toEqual([]);
  });

  it('keeps namespace/type references and ignores nonadjacent annotations, raw strings and directives', async () => {
    write('Types.h', `
#define EXAMPLE UPROPERTY() int FakeDirective;
const char* Example = R"example(
UPROPERTY() int FakeRaw;
)example";
namespace Bake {
class UBakeAsset {};
DECLARE_DELEGATE_RetVal(int, FGetBake);
USTRUCT()
struct FHolder {
 UPROPERTY() UBakeAsset* Asset;
 UPROPERTY() unsigned Flags : 1;
};
UPROPERTY()
int unrelated();
int MustStayOrdinary;
}
`);
    graph = CodeGraph.initSync(root);
    await graph.sync();
    expect(graph.getNodesByName('FGetBake')[0]).toMatchObject({ kind: 'type_alias', qualifiedName: 'Bake::FGetBake' });
    expect(graph.getNodesByName('Asset')[0]).toMatchObject({ kind: 'field', qualifiedName: 'Bake::FHolder::Asset' });
    const asset = graph.getNodesByName('Asset')[0]!;
    const assetType = graph.getNodesByName('UBakeAsset')[0]!;
    expect(graph.getOutgoingEdges(asset.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: assetType.id, kind: 'references' }),
    ]));
    expect(graph.getNodesByName('Flags')[0]?.decorators).toContain('UPROPERTY()');
    expect(graph.getNodesByName('FakeRaw')).toEqual([]);
    expect(graph.getNodesByName('FakeDirective')).toEqual([]);
    expect(graph.getNodesByName('MustStayOrdinary').every(n => !n.decorators?.some(d => d.startsWith('UPROPERTY(')))).toBe(true);
  });

  it('does not associate a reflected declaration with duplicate definitions or an unsupported function-pointer signature', async () => {
    write('Dupe.h', `UCLASS()
class ULicense {
public:
 UFUNCTION() void Run(int Count);
 UFUNCTION() void Complex(void (*Callback)(int));
};\n`);
    write('First.cpp', '#include "Dupe.h"\nvoid ULicense::Run(int Value) {}\nvoid ULicense::Complex(void (*Other)(int)) {}\n');
    write('Second.cpp', '#include "Dupe.h"\nvoid ULicense::Run(int Other) {}\n');
    graph = CodeGraph.initSync(root);
    await graph.sync();
    const declarations = graph.getNodesByName('Run').concat(graph.getNodesByName('Complex')).filter(n => n.filePath === 'Dupe.h');
    expect(declarations).toHaveLength(2);
    for (const declaration of declarations) expect(graph.getCallees(declaration.id)).toEqual([]);
  });

  it('preserves unnamed multiword types and cv qualifiers instead of treating them as parameter names', async () => {
    write('Overload.h', `UCLASS()
class UProbe {
public:
 UFUNCTION() void Width(unsigned long);
 UFUNCTION() void KeepConst(FValue const);
 UFUNCTION() void Named(const TArray<int>& Values, int Count = 3) const;
};\n`);
    write('Overload.cpp', `#include "Overload.h"
void UProbe::Width(unsigned long long Value) {}
void UProbe::KeepConst(FValue Value) {}
void UProbe::Named(const TArray<int>& Renamed, int Other) const {}
`);
    graph = CodeGraph.initSync(root);
    await graph.sync();
    for (const name of ['Width', 'KeepConst']) {
      const declaration = graph.getNodesByName(name).find(n => n.filePath === 'Overload.h')!;
      expect(declaration).toBeDefined();
      expect(graph.getCallees(declaration.id)).toEqual([]);
    }
    const named = graph.getNodesByName('Named').find(n => n.filePath === 'Overload.h')!;
    expect(graph.getCallees(named.id).map(r => r.node.filePath)).toEqual(['Overload.cpp']);
  });

  it('detects a delegate-only header as C++ while leaving comment-only C headers as C', async () => {
    write('Event.h', 'DECLARE_MULTICAST_DELEGATE(FReady);\n');
    write('Plain.h', '// DECLARE_MULTICAST_DELEGATE(FFake);\n#define SAMPLE DECLARE_DELEGATE(FFake)\nint PlainValue;\n');
    graph = CodeGraph.initSync(root);
    await graph.sync();
    expect(graph.getFile('Event.h')?.language).toBe('cpp');
    expect(graph.getNodesByName('FReady')[0]?.kind).toBe('type_alias');
    expect(graph.getFile('Plain.h')?.language).toBe('c');
    expect(graph.getNodesByName('FFake')).toEqual([]);
  });

  it('assigns same-line and nested delegate fields to their exact AST owner', async () => {
    write('Owners.h', `DECLARE_MULTICAST_DELEGATE(FReady);
class A {}; class B { FReady Ready; }; class Outer { class Inner { FReady Ready; }; FReady Ready; };
`);
    graph = CodeGraph.initSync(root);
    await graph.sync();
    expect(graph.getNodesByName('Ready').filter(n => n.kind === 'field').map(n => n.qualifiedName).sort()).toEqual([
      'B::Ready', 'Outer::Inner::Ready', 'Outer::Ready',
    ]);
  });

  it('does not collapse distinct unnamed elaborated parameter types to the same signature', async () => {
    write('Elaborated.h', `struct FAlpha {}; struct FBeta {};
UCLASS()
class UElaborated {
public:
 UFUNCTION() void Pick(const struct FAlpha);
};\n`);
    write('Elaborated.cpp', '#include "Elaborated.h"\nvoid UElaborated::Pick(const struct FBeta) {}\n');
    graph = CodeGraph.initSync(root);
    await graph.sync();
    const declaration = graph.getNodesByName('Pick').find(n => n.filePath === 'Elaborated.h')!;
    expect(declaration).toBeDefined();
    expect(graph.getCallees(declaration.id)).toEqual([]);
  });

  it('does not attach an unrelated module definition merely because its written signature matches', async () => {
    write('First.h', 'UCLASS()\nclass UShared { public:\n UFUNCTION() void Run(int Count);\n};\n');
    write('Other.h', 'class UShared { public: void Run(int Count); };\n');
    write('Other.cpp', '#include "Other.h"\nvoid UShared::Run(int Count) {}\n');
    graph = CodeGraph.initSync(root);
    await graph.sync();
    const declaration = graph.getNodesByName('Run').find(n => n.filePath === 'First.h')!;
    expect(declaration).toBeDefined();
    expect(graph.getCallees(declaration.id)).toEqual([]);
  });
});
