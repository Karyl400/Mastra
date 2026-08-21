import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

const DIRECTIVE = /^\s*(?:\/\/|\/\*)\s*(?:eslint-|@ts-|prettier-|istanbul |c8 |v8 |@vitest|#__)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Comment {
  readonly file: string;
  readonly line: number;
  readonly body: string;
}

function commentsOf(file: string): Comment[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found: Comment[] = [];
  const seen = new Set<number>();

  const collect = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const body = text.slice(range.pos, range.end);
      if (DIRECTIVE.test(body)) continue;
      found.push({
        file: file.slice(ROOT.length + 1),
        line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
        body: body.split('\n')[0]!.trim().slice(0, 90),
      });
    }
  };

  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

describe('le POURQUOI vit dans docs/conception/, plus dans le code', () => {
  const files = walk(join(ROOT, 'src'));

  it('scanne effectivement src/ — anti faux-négatif', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it('reconnaît une directive et un commentaire explicatif — anti faux-négatif', () => {
    expect(DIRECTIVE.test('// eslint-disable-next-line no-console')).toBe(true);
    expect(DIRECTIVE.test('/* @ts-expect-error */')).toBe(true);
    expect(DIRECTIVE.test('// On coupe de la fin vers le début.')).toBe(false);
  });

  it('aucun fichier de src/ ne porte de commentaire explicatif', () => {
    const stragglers = files.flatMap(commentsOf);

    expect(
      stragglers,
      stragglers.length
        ? `Le POURQUOI a été sorti du code le 2026-08-21 vers docs/conception/ — une page ` +
            `par feature, ancrée sur la DÉCLARATION et jamais sur un numéro de ligne.\n` +
            `Ces commentaires sont revenus dans src/ :\n  - ` +
            stragglers.map((c) => `${c.file}:${c.line}  ${c.body}`).join('\n  - ') +
            `\nÉcrire la décision dans docs/conception/<feature>.md, dans le MÊME commit : ` +
            `une page qui décrit un état révolu est pire qu'une page absente.`
        : undefined,
    ).toEqual([]);
  });
});
