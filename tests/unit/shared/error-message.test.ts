import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorMessage } from '../../../src/shared/errors';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SCANNED_DIRS = ['src', 'scripts'];

/**
 * `errorMessage` était recopié à la main dans une vingtaine de `catch`, et les copies avaient
 * DIVERGÉ sur le seul cas qui les distingue : la valeur rejetée n'est pas une `Error`.
 *
 * Ce cas n'est pas théorique — `@slack/web-api` rejette parfois un objet nu portant
 * `data.error`, et `Promise.reject('…')` est légal partout.
 *
 * Les replis mesurés avant unification :
 *   `String(error)`     ≈ 12 sites — équivalent au helper ;
 *   `'Unknown error'`   4 sites (`connection.ts`) ;
 *   `'Erreur inconnue'` 1 site  (`send-notification.ts`) ;
 *   `''`                1 site  (`generate-document.ts`).
 *
 * Les six derniers EFFACENT le diagnostic : sur un rejet non-`Error`, la moitié du dépôt
 * journalisait la valeur et l'autre moitié une constante identique quelle que soit la panne.
 * C'est exactement le mode de défaut que ce dépôt traque ailleurs — un silence qui a l'air
 * d'une information.
 */
describe('errorMessage', () => {
  it('rend le message d’une `Error`', () => {
    expect(errorMessage(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('n’EFFACE pas une valeur rejetée qui n’est pas une `Error`', () => {
    // Le point de toute l'unification : ces trois valeurs donnaient « Unknown error »,
    // « Erreur inconnue » ou « » selon le fichier où l'on tombait.
    expect(errorMessage('rate limited')).toBe('rate limited');
    expect(errorMessage(429)).toBe('429');
    expect(errorMessage(null)).toBe('null');
  });

  it('rend le message des sous-classes du dépôt', () => {
    class Boom extends Error {}
    expect(errorMessage(new Boom('boom'))).toBe('boom');
  });
});

/**
 * Fichiers où la recopie survit à dessein ou par appartenance à un autre lot.
 *
 * `llm-guardrail.ts` porte trois occurrences de `'Unknown error'` ; il est édité en parallèle
 * et n'a pas été touché ici. Cette entrée est une DETTE, pas une exemption de principe.
 */
const KNOWN_INLINE_COPIES: readonly string[] = ['src/shared/security/llm-guardrail.ts'];

/** La recopie littérale : `x instanceof Error ? x.message : <repli>`. */
const INLINE_COPY_RE = /instanceof\s+Error\s*\?\s*[\w.]+\.message\s*:/;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSourceFiles(full, acc);
    } else if (/\.(ts|mts)$/.test(full) && !full.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('la recopie inline de `errorMessage`', () => {
  it('ne revient pas dans `src/` ni dans `scripts/`', () => {
    const offenders: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of collectSourceFiles(path.join(REPO_ROOT, dir))) {
        const relative = path.relative(REPO_ROOT, file);
        if (relative === 'src/shared/errors.ts') continue;
        if (KNOWN_INLINE_COPIES.includes(relative)) continue;
        if (INLINE_COPY_RE.test(fs.readFileSync(file, 'utf8'))) offenders.push(relative);
      }
    }

    expect(offenders, 'Utiliser `errorMessage` de `src/shared/errors.ts`').toEqual([]);
  });

  it('reste détectée là où elle existe encore — sans quoi le test ci-dessus serait vide de sens', () => {
    // Un scanner qui ne reconnaît pas ce qu'il interdit est vert et creux : ce dépôt a déjà
    // payé ce défaut (`READ_ONLY_TOOL_NAMES` gardant un outil retiré).
    expect(INLINE_COPY_RE.test('const m = error instanceof Error ? error.message : "x";')).toBe(
      true,
    );
    expect(INLINE_COPY_RE.test('const m = err instanceof Error ? err.message : String(err);')).toBe(
      true,
    );
    for (const known of KNOWN_INLINE_COPIES) {
      expect(INLINE_COPY_RE.test(fs.readFileSync(path.join(REPO_ROOT, known), 'utf8'))).toBe(true);
    }
  });
});

/**
 * Les variantes NON-message laissées en place à dessein : elles ne prétendent pas rendre un
 * message, elles rendent autre chose, et le remplacer appauvrirait le diagnostic.
 */
describe('les variantes non-message', () => {
  it('sont laissées telles quelles', () => {
    const deliberate: ReadonlyArray<{ file: string; snippet: string }> = [
      // `errorName` est journalisé À CÔTÉ de `errorMessage` : c'est la classe du maillon en
      // échec, la seule façon de distinguer un `AI_APICallError` d'un `TypeError`.
      { file: 'src/shared/llm/model-fallback.ts', snippet: 'error instanceof Error ? error.name' },
      // `errorType` accompagne `error` (l'objet entier) dans le même log.
      {
        file: 'src/features/notification/infrastructure/handlers/slack-events.handler.ts',
        snippet: 'error instanceof Error ? error.constructor.name',
      },
      // Ici l'`Error` elle-même devient la `cause` d'une `DatabaseConnectionError` — on ne
      // transporte pas un message mais la chaîne d'origine.
      {
        file: 'src/infrastructure/database/connection.ts',
        snippet: 'error instanceof Error ? error : undefined',
      },
    ];

    for (const { file, snippet } of deliberate) {
      expect(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).toContain(snippet);
    }
  });
});
