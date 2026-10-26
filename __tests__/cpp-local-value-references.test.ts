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

  it('keeps multiline control initializers local through their headers and bodies only', async () => {
    const source = lines(
      'struct Payload { int Value; };',
      'Payload Product;',
      'int Multiline(bool Take, Payload Arg) {',
      '  int Sum = Product.Value; // before controls',
      '  if (',
      '    Payload Product = Arg;',
      '    Take && Product.Value > 0',
      '  ) { Sum += Product.Value; } else { Sum -= Product.Value; }',
      '  Sum += Product.Value; // after multiline if',
      '  for (',
      '    Payload Product = Arg;',
      '    Product.Value < 1;',
      '    ++Product.Value',
      '  ) Sum += Product.Value;',
      '  Sum += Product.Value; // after multiline for',
      '  switch (',
      '    Payload Product = Arg;',
      '    Product.Value',
      '  ) { case 0: Sum += Product.Value; break; }',
      '  Sum += Product.Value; // after multiline switch',
      '  if constexpr (Payload Product = Arg; true) { Sum += Product.Value; }',
      '  if (Payload* Product = &Arg; Take) { Sum += Product->Value; }',
      '  if (Payload& Product = Arg; Take) { Sum += Product.Value; }',
      '  return Sum + Product.Value; // after constexpr if',
      '}',
    );
    const cg = await indexed({ 'multiline-controls.cpp': source });
    try {
      expect(targets(cg, 'Multiline', 'references')).toEqual([
        'int Sum = Product.Value;',
        'Sum += Product.Value; // after multiline if',
        'Sum += Product.Value; // after multiline for',
        'Sum += Product.Value; // after multiline switch',
        'return Sum + Product.Value;',
      ].map((text) => `${lineOf(source, text)} -> Product`).sort());
    } finally {
      cg.close();
    }
  });

  it('binds each else to its own unbraced if before ending the enclosing control scope', async () => {
    const source = lines(
      'struct Payload { int Value; };',
      'Payload Product;',
      'int Nested(bool Take, bool Inner, Payload Arg) {',
      '  int Sum = 0;',
      '  if (Payload Product = Arg; Take)',
      '    if (Inner) { Sum += Product.Value; }',
      '    else { Sum -= Product.Value; }',
      '  else if (Inner) Sum += Product.Value;',
      '  else',
      '    for (int Index = 0; Index < 1; ++Index)',
      '      if (Take) Sum += Product.Value;',
      '      else Sum -= Product.Value;',
      '  Sum += Product.Value; // after nested if',
      '  for (Payload Product = Arg; Product.Value < 1; ++Product.Value)',
      '    if (Take) Sum += Product.Value;',
      '    else Sum -= Product.Value;',
      '  Sum += Product.Value; // after unbraced for',
      '  if (Payload Product = Arg; Take)',
      '    do { Sum += Product.Value; } while (Product.Value > 0);',
      '  else Sum -= Product.Value;',
      '  return Sum + Product.Value; // after do while',
      '}',
    );
    const cg = await indexed({ 'nested-controls.cpp': source });
    try {
      expect(targets(cg, 'Nested', 'references')).toEqual([
        'Sum += Product.Value; // after nested if',
        'Sum += Product.Value; // after unbraced for',
        'return Sum + Product.Value;',
      ].map((text) => `${lineOf(source, text)} -> Product`).sort());
    } finally {
      cg.close();
    }
  });

  it('keeps qualified calls and conditional expressions inside an attributed single-statement body', async () => {
    const source = lines(
      'struct Payload { int Value; };',
      'Payload Product;',
      'namespace Values { int constructor(int Value) { return Value; } }',
      'int Expressions(bool Take, Payload Arg) {',
      '  int Sum = 0;',
      '  for (Payload Product = Arg; Product.Value < 1; ++Product.Value)',
      '    Sum += Values::constructor(Product.Value) ? Product.Value : Product.Value;',
      '  Sum += Product.Value; // after conditional expression',
      '  if (Payload Product = Arg; Take)',
      '    [[likely]] while (Take) Sum += Values::constructor(Product.Value);',
      '  else { /* else ; } */ const char* Text = "; } else"; Sum += Product.Value; }',
      '  return Sum + Product.Value; // after attributed while',
      '}',
    );
    const cg = await indexed({ 'control-expressions.cpp': source });
    try {
      expect(targets(cg, 'Expressions', 'references')).toEqual([
        'Sum += Product.Value; // after conditional expression',
        'return Sum + Product.Value;',
      ].map((text) => `${lineOf(source, text)} -> Product`).sort());
    } finally {
      cg.close();
    }
  });

  it.each([['*', ','], ['*', ';'], ['&', ','], ['&', ';']])('keeps global body reads when a control header uses %s before %s', async (operator, separator) => {
    const source = lines(
      'struct Payload { int Value; Payload operator[](int Index) const { return *this; } };',
      'Payload Product;',
      `int operator${operator}(int Factor, Payload Value) { return Factor; }`,
      'int CommaExpressions(int A) {',
      '  int Sum = 0;',
      '  int Factor = A;',
      '  if (',
      `    A ${operator} Product${separator}`,
      '    true',
      '  ) { Sum += Product.Value; } // parameter multiplication',
      '  if (',
      `    Factor ${operator} Product${separator}`,
      '    true',
      '  ) { Sum += Product.Value; } // local multiplication',
      '  if (',
      `    A ${operator} Factor, Product${separator}`,
      '    true',
      '  ) { Sum += Product.Value; } // comma sequence',
      '  if (',
      `    A ${operator} Product[0]${separator}`,
      '    true',
      '  ) { Sum += Product.Value; } // indexed expression',
      '  return Sum + Product.Value; // after comma conditions',
      '}',
    );
    const cg = await indexed({ 'comma-conditions.cpp': source });
    try {
      // The parser can classify the ambiguous header as a declarator; this
      // guard must still preserve the ordinary global reads in its body.
      expect(targets(cg, 'CommaExpressions', 'references')).toEqual(expect.arrayContaining([
        ') { Sum += Product.Value; } // parameter multiplication',
        ') { Sum += Product.Value; } // local multiplication',
        ') { Sum += Product.Value; } // comma sequence',
        ') { Sum += Product.Value; } // indexed expression',
        'return Sum + Product.Value;',
      ].map((text) => `${lineOf(source, text)} -> Product`)));
    } finally {
      cg.close();
    }
  });
});
