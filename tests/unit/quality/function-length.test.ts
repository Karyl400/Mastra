import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LINES = 100;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|mts)$/.test(name) ? [path] : [];
  });
}

function longFunctions(path: string): string[] {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart()).line;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      const length = end - start + 1;
      if (length > MAX_LINES) {
        found.push(
          `${path}:${start + 1} ${node.name?.getText() ?? '(anonyme)'} — ${length} lignes`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return found;
}

describe('longueur des fonctions (S7)', () => {
  it(`aucune fonction de src/ ne dépasse ${MAX_LINES} lignes`, () => {
    const offenders = sourceFiles('src').flatMap(longFunctions);
    expect(offenders).toEqual([]);
  });
});
