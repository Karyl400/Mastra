import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « Verrouillé par `X` » doit citer un fichier qui existe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 45 % de `src/` est du commentaire, et c'est un actif : les explications locales et
 * vérifiables sur place de ce dépôt sont ce qui rend ses arbitrages relisibles.
 *
 * ⚠️ Mais une revue du 2026-08-19 a trouvé TROIS défauts qu'un commentaire avait masqués, et
 * ils partagent une forme : **le commentaire énonce une propriété GLOBALE que rien ne
 * recalcule** — « la seule feature qui… », « verrouillé par… », « délibérément absente ».
 * Une phrase d'autorité se relit comme une preuve, et dispense de vérifier.
 *
 * Le cas le plus coûteux : `claim-reconciliation.ts` portait « ⚠️ Verrouillé par
 * `tests/unit/quality/tool-classification.test.ts` : tout outil câblé doit être classé ici ».
 * Ce fichier N'EXISTAIT PAS. La liste avait dérivé exactement comme la phrase le prédisait,
 * et la réconciliation FAIT/NARRATION était éteinte sur le chemin le plus fréquent du produit.
 *
 * Ce dépôt s'est donné la discipline de DÉRIVER ses listes (`AGENT_TOOLS`,
 * `DETERMINISTIC_REPLIES`, `agentToolBoundary` construit sur `Object.keys`). Il ne se l'était
 * pas donnée pour ses propres énoncés d'invariant. C'est ce que ce test répare — et il aurait
 * attrapé le défaut ci-dessus le jour même où la phrase a été écrite.
 *
 * ⚠️ Portée VOLONTAIREMENT ÉTROITE : seule la forme « verrouillé par `chemin` » est vérifiée.
 * Les commentaires citant un fichier SUPPRIMÉ à titre historique — « `_measure.mts` est
 * périmé », « `task-summary.mapper.ts` a été retiré » — sont légitimes et ne doivent pas
 * rougir. Une garde qui crie sur du texte juste finit désactivée.
 */

const ROOT = resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** « verrouillé par `chemin` », toutes désinences, dans n'importe quel commentaire. */
const LOCK_CLAIM = /[Vv]errouill(?:é|ee|é|és|ées|ée)?s?\s+par\s+`([^`]+)`/gu;

describe('les invariants ANNONCÉS dans les commentaires citent un fichier réel', () => {
  it('chaque « verrouillé par `X` » de src/ désigne un fichier qui existe', () => {
    const broken: string[] = [];

    for (const file of walk(join(ROOT, 'src'))) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(LOCK_CLAIM)) {
        const cited = match[1]!;
        // On ne vérifie que ce qui RESSEMBLE à un chemin de fichier du dépôt. « verrouillé par
        // `un test` » ou « verrouillé par `AGENT_TOOLS` » ne désigne pas un fichier.
        if (!cited.includes('/') || !/\.(ts|mts|mjs|js|sql)$/.test(cited)) continue;
        if (!existsSync(join(ROOT, cited))) {
          broken.push(`${file.slice(ROOT.length + 1)} cite « ${cited} », qui n’existe pas`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it('le motif attrape bien la forme qui a échoué — anti faux-négatif', () => {
    // Sans cette vérification, une regex qui ne matche RIEN rendrait le test vert pour
    // toujours. C'est la même précaution que `architecture.test.ts`, qui compte les fichiers
    // qu'il a réellement scannés.
    const sample =
      '⚠️ Verrouillé par `tests/unit/quality/tool-classification.test.ts` : tout outil câblé…';
    const found = [...sample.matchAll(LOCK_CLAIM)].map((m) => m[1]);

    expect(found).toEqual(['tests/unit/quality/tool-classification.test.ts']);
  });

  it('scanne effectivement des fichiers — anti faux-négatif', () => {
    expect(walk(join(ROOT, 'src')).length).toBeGreaterThan(100);
  });
});
