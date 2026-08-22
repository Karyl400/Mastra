import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(d: string, o: string[] = []): string[] {
  for (const e of readdirSync(d)) {
    const f = join(d, e);
    if (statSync(f).isDirectory()) walk(f, o);
    else if (f.endsWith('.ts')) o.push(f);
  }
  return o;
}

interface Fn {
  file: string;
  name: string;
  lines: number;
  params: number;
  depth: number;
  complexity: number;
}
const fns: Fn[] = [];

function complexityOf(node: ts.Node): number {
  let c = 1;
  const visit = (n: ts.Node) => {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        c += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (n as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        )
          c += 1;
        break;
      }
    }
    n.forEachChild(visit);
  };
  node.forEachChild(visit);
  return c;
}

function maxDepth(node: ts.Node): number {
  let max = 0;
  const visit = (n: ts.Node, d: number) => {
    const nests = [
      ts.SyntaxKind.IfStatement,
      ts.SyntaxKind.ForStatement,
      ts.SyntaxKind.ForOfStatement,
      ts.SyntaxKind.ForInStatement,
      ts.SyntaxKind.WhileStatement,
      ts.SyntaxKind.TryStatement,
      ts.SyntaxKind.SwitchStatement,
    ].includes(n.kind);
    const nd = nests ? d + 1 : d;
    if (nd > max) max = nd;
    n.forEachChild((c) => visit(c, nd));
  };
  node.forEachChild((c) => visit(c, 0));
  return max;
}

for (const file of walk('src')) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const visit = (n: ts.Node) => {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n)
    ) {
      const start = sf.getLineAndCharacterOfPosition(n.getStart()).line;
      const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
      const lines = end - start + 1;
      let name = '(anonyme)';
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
        name = n.name.getText();
      else if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name))
        name = n.parent.name.text;
      else if (ts.isPropertyAssignment(n.parent)) name = n.parent.name.getText();
      if (lines >= 4)
        fns.push({
          file: file,
          name,
          lines,
          params: n.parameters.length,
          depth: maxDepth(n),
          complexity: complexityOf(n),
        });
    }
    n.forEachChild(visit);
  };
  visit(sf);
}

const big = fns.filter((f) => f.lines > 30).sort((a, b) => b.lines - a.lines);
console.log(`fonctions >= 4 lignes : ${fns.length}`);
console.log(`fonctions > 30 lignes : ${big.length}`);
console.log(`fonctions > 50 lignes : ${fns.filter((f) => f.lines > 50).length}`);
console.log(`complexité > 15       : ${fns.filter((f) => f.complexity > 15).length}`);
console.log(`profondeur > 3        : ${fns.filter((f) => f.depth > 3).length}`);
console.log(`params >= 4           : ${fns.filter((f) => f.params >= 4).length}`);
console.log('\n=== TOP 25 par lignes ===');
for (const f of big.slice(0, 25)) {
  console.log(
    `${String(f.lines).padStart(4)}l  cc=${String(f.complexity).padStart(3)}  prof=${f.depth}  p=${f.params}  ${f.name}  —  ${f.file.replace('src/', '')}`,
  );
}
console.log('\n=== TOP 15 par complexité ===');
for (const f of [...fns].sort((a, b) => b.complexity - a.complexity).slice(0, 15)) {
  console.log(
    `cc=${String(f.complexity).padStart(3)}  ${String(f.lines).padStart(4)}l  ${f.name}  —  ${f.file.replace('src/', '')}`,
  );
}
