import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../../src');
const OWNER = 'shared/rows-affected.ts';

// Un `.run()` Drizzle/libsql rend un `ResultSet` TYPÉ : `result.rowsAffected` y est un `number`
// garanti par le compilateur, et n'est donc pas visé. Ce qui l'est, c'est le compte DEVINÉ —
// un cast vers un champ optionnel, ou un repli `??`.
const GUESSED = /rowsAffected\??\s*\?\?|rowsAffected\?\s*:/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Audit QA du 2026-08-28, §9bis.1 — fermé le 2026-10-16.
 *
 * `rowsAffected ?? 0` fait de « je n'ai pas pu compter » un « zéro ligne ». Sur l'effacement,
 * Marcel répondait « je n'avais rien retenu » après avoir tout détruit. Le compte se lit
 * désormais en UN seul endroit, qui lève — ou qui rend un repli DÉCLARÉ et journalisé, là où
 * zéro est le bon sens de panne (`pendingEmail.clear` : ne pas envoyer).
 */
describe('le nombre de lignes touchées n’est jamais deviné', () => {
  it('aucun fichier de src/ ne DEVINE `rowsAffected` (cast optionnel ou `??`) hors de shared/rows-affected.ts', () => {
    const offenders = sources(SRC)
      .filter((file) => relative(SRC, file) !== OWNER)
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(SRC, file)}:${i + 1}` }))
          .filter(({ line }) => GUESSED.test(line))
          .map(({ at }) => at),
      );

    expect(offenders).toEqual([]);
  });

  it('le scan n’est pas vide — il voit bien le fichier propriétaire', () => {
    expect(sources(SRC).some((file) => relative(SRC, file) === OWNER)).toBe(true);
  });
});
