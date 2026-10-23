import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-local-value-'));
  roots.push(root);
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), source);
  }
  return CodeGraph.init(root, { index: true });
}

function targets(cg: CodeGraph, caller: string, kind: 'references' | 'calls' | 'instantiates'): string[] {
  const node = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')]
    .find((n) => n.qualifiedName === caller);
  expect(node, caller).toBeDefined();
  return cg.getOutgoingEdgesFrom([node!.id], [kind])
    .map((edge) => `${edge.line} -> ${cg.getNode(edge.target)!.qualifiedName}`).sort();
}

const lines = (...source: string[]): string => [...source, ''].join('\n');
const lineOf = (source: string, text: string): number => source.slice(0, source.indexOf(text)).split('\n').length;

describe('C++ value references bound in the calling function', () => {
  it('does not turn AxFImporter locals and parameters into an enum member or unrelated method', async () => {
    const source = lines(
      'struct FMaterialExpressionWrapper { int OutputIndex; void* Expression; };',
      'struct FExpressionInput { void Connect(int index, void* expression) {} };',
      'struct UMaterialExpressionSubtract { float ConstA; FExpressionInput B; };',
      'FMaterialExpressionWrapper Box(UMaterialExpressionSubtract* expression) { return {}; }',
      'class Arithmetic {',
      ' public:',
      '  FMaterialExpressionWrapper Sub(float A, FMaterialExpressionWrapper B) {',
      '    UMaterialExpressionSubtract* Product = nullptr;',
      '    Product->ConstA = A;',
      '    Product->B.Connect(B.OutputIndex, B.Expression);',
      '    return Box(Product);',
      '  }',
      '};',
      'int ExplicitMember(ICreatedMaterial& material, int B) { return material.B(); }',
      'class Owner {',
      ' public:',
      '  int B() const { return 0; }',
      '  int Call(int B) { return this->B(); }',
      '};',
      'FMaterialExpressionWrapper TypeUse() { return FMaterialExpressionWrapper(); }',
    );
    const cg = await indexed({
      'material/Arithmetic.cpp': source,
      'elsewhere/Names.h': lines(
        'enum class EPCGMetadataMathOperation { Product };',
        'class ICreatedMaterial { public: int B() const { return 0; } };',
      ),
    });
    try {
      expect(targets(cg, 'Arithmetic::Sub', 'references')).toEqual([]);
      expect(targets(cg, 'Arithmetic::Sub', 'calls')).toContain(`${lineOf(source, 'return Box(Product)')} -> Box`);
      expect(targets(cg, 'ExplicitMember', 'calls')).toContain(`${lineOf(source, 'int ExplicitMember')} -> ICreatedMaterial::B`);
      expect(targets(cg, 'Owner::Call', 'calls')).toContain(`${lineOf(source, 'int Call')} -> Owner::B`);
      expect(targets(cg, 'TypeUse', 'instantiates')).toContain(`${lineOf(source, 'FMaterialExpressionWrapper TypeUse')} -> FMaterialExpressionWrapper`);
    } finally {
      cg.close();
    }
  });

  it('keeps global reads before a declaration and after nested or inline local scopes close', async () => {
    const source = lines(
      'struct Payload { int Value; };',
      'Payload Product;',
      'int Scope(bool Shadow, Payload Arg) {',
      '  int Sum = Product.Value; // before',
      '  if (Shadow) {',
      '    Payload Product = Arg;',
      '    Sum += Product.Value; // outer local',
      '    { Payload Product = Arg; Sum += Product.Value; } // nested local',
      '    Sum += Product.Value; // outer local again',
      '  }',
      '  Sum += Product.Value; // after nested',
      '  { Payload Product = Arg; Sum += Product.Value; } // inline local',
      '  Sum += Product.Value; // after inline',
      '  return Sum;',
      '}',
    );
    const cg = await indexed({ 'scope.cpp': source });
    try {
      expect(targets(cg, 'Scope', 'references')).toEqual([4, 11, 13].map((line) => `${line} -> Product`).sort());
    } finally {
      cg.close();
    }
  });

  it('ends for/if/switch initializer bindings at the control statement, retaining local reads inside', async () => {
    const source = lines(
      'struct Payload { int Value; };',
      'Payload Product;',
      'int ControlScopes(bool Take, Payload Arg) {',
      '  int Sum = 0;',
      '  for (Payload Product = Arg; Product.Value < 1; ++Product.Value) {',
      '    Sum += Product.Value;',
      '  }',
      '  Sum += Product.Value; // after for',
      '  if (Payload Product = Arg; Product.Value > 0) {',
      '    Sum += Product.Value;',
      '  } else {',
      '    Sum += Product.Value;',
      '  }',
      '  Sum += Product.Value; // after if',
      '  switch (Payload Product = Arg; Product.Value) {',
      '    case 0: Sum += Product.Value; break;',
      '  }',
      '  return Sum + Product.Value;',
      '}',
    );
    const cg = await indexed({ 'control-scopes.cpp': source });
    try {
      expect(targets(cg, 'ControlScopes', 'references')).toEqual([8, 14, 18].map((line) => `${line} -> Product`).sort());
    } finally {
      cg.close();
    }
  });
});
