import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « Verrouillé par `X` » doit citer un fichier qui existe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Ce bloc a été écrit quand 45 % de `src/` était du commentaire. Depuis le 2026-08-21, le
 * code n'en porte plus aucun — le corpus a déménagé dans `docs/conception/`, et c'est le
 * SECOND bloc de ce fichier qui le garde. Celui-ci ne couvre plus que les chaînes de
 * caractères de `src/` : une phrase « verrouillé par `X` » écrite dans un message reste une
 * affirmation d'autorité, et doit désigner un fichier qui existe.
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

// ════════════════════════════════════════════════════════════════════════════
// LA PORTÉE S'ÉLARGIT — le corpus a déménagé, le garde-fou pas
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ L'audit du 2026-08-21 a mesuré que la garde ci-dessus **ne gardait plus rien** :
// `grep -rhoE 'verrouill.* par \`[^\`]+\`' src/` rend ZÉRO correspondance. Ce n'est pas qu'elle
// ait été respectée — c'est que le corpus a bougé. Le 2026-08-20, les commentaires ont été
// extraits du code vers `docs/conception/` : `src/` ne porte plus que **5** citations de chemin,
// `docs/` en porte **211**.
//
// Une garde dont l'objet a déménagé est une garde vide, et elle se lit comme une protection.
//
// ⚠️ **TROIS EXCLUSIONS, chacune pour une raison, aucune par confort :**
//
//  1. `docs/audit-*` — un rapport d'audit LISTE les références mortes ; c'est son sujet. L'y
//     interdire rendrait impossible d'écrire ce que ce test existe pour prévenir.
//  2. `docs/plans/` et `docs/superpowers/plans/` — des plans DATÉS décrivent une intention
//     passée. Les réécrire a posteriori falsifie le registre, exactement ce que la règle
//     « ne jamais modifier un ADR, en créer un nouveau » protège.
//  3. Toute citation dont le VOISINAGE annonce une suppression (« supprimé », « retiré »,
//     « périmé », « n'existe plus »…). Une mention historique explicite est légitime — et une
//     garde qui crie sur du texte juste finit désactivée. C'est déjà l'arbitrage du test
//     ci-dessus, appliqué au nouveau corpus.

const DOC_ROOTS = ['docs', '.claude'] as const;

const EXCLUDED_DOCS = [/\/audit-/, /\/plans\//];

/** Un chemin du dépôt, cité entre accents graves. */
const CITED_PATH = /`((?:src|tests|scripts|drizzle)\/[\w./-]+\.(?:ts|mts|mjs|js|sql))`/g;

/**
 * Marqueurs qui rendent une citation LÉGITIME bien que le fichier n'existe plus.
 *
 * ⚠️ La fenêtre est de trois lignes de part et d'autre : dans la prose de ce dépôt, la mention
 * de suppression et le chemin ne sont presque jamais sur la même ligne.
 */
const REMOVAL_MARKER =
  /supprim|retir|périm|perim|n'existe plus|n’existe plus|disparu|jamais existé|n'a jamais|n’a jamais|caduque|avant sa suppression|remplacé|fantôme|inexistant/i;

/**
 * Un document qui se DÉCLARE périmé dans son en-tête est exempté en entier.
 *
 * ⚠️ **Cette règle rend la bannière OPÉRANTE plutôt que décorative.** Sans elle, marquer un
 * document obsolète en tête ne suffisait pas : chaque citation devait porter sa propre mention,
 * ce qui poussait soit à réécrire un document historique (donc à falsifier le registre), soit à
 * exclure son chemin à la main dans ce test (donc à recopier une liste, la faute que tout ce
 * fichier combat).
 *
 * La marque doit être dans les 20 premières lignes : un avertissement enterré au milieu d'un
 * document ne prévient personne.
 */
const OBSOLETE_BANNER = /DOCUMENT\s+PÉRIMÉ|DOCUMENT\s+OBSOLÈTE|⚠️\s*PÉRIMÉ/i;

function declaresItselfObsolete(file: string): boolean {
  return OBSOLETE_BANNER.test(readFileSync(file, 'utf8').split('\n').slice(0, 20).join('\n'));
}

function walkDocs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDocs(full, out);
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}

describe('la documentation VERSIONNÉE ne cite aucun fichier disparu', () => {
  const files = DOC_ROOTS.flatMap((root) => walkDocs(join(ROOT, root)))
    .filter((file) => !EXCLUDED_DOCS.some((pattern) => pattern.test(file)))
    .filter((file) => !declaresItselfObsolete(file));

  it('scanne effectivement le corpus — anti faux-négatif', () => {
    // C'est exactement l'assertion qui manquait : la garde d'origine est devenue vide sans que
    // rien ne le signale. Ici, un corpus qui rétrécit fait rougir le test.
    expect(files.length).toBeGreaterThan(15);

    const citations = files.flatMap((file) => [
      ...readFileSync(file, 'utf8').matchAll(CITED_PATH),
    ]).length;
    expect(citations).toBeGreaterThan(50);
  });

  it('chaque chemin cité existe, ou sa disparition est ANNONCÉE dans la phrase', () => {
    const broken: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(CITED_PATH)) {
          const cited = match[1]!;
          if (existsSync(join(ROOT, cited))) continue;

          const context = lines.slice(Math.max(0, index - 3), index + 4).join(' ');
          if (REMOVAL_MARKER.test(context)) continue;

          broken.push(`${file.slice(ROOT.length + 1)}:${index + 1} cite « ${cited} », absent`);
        }
      });
    }

    expect(
      broken,
      broken.length
        ? `Documentation citant un fichier disparu, sans le dire :\n  - ${broken.join('\n  - ')}\n` +
            `Soit le chemin est faux, soit la phrase doit annoncer la suppression ` +
            `(« supprimé », « retiré », « n'existe plus »…). Une phrase au PRÉSENT qui nomme un ` +
            `fichier absent est la forme exacte du défaut que ce fichier existe pour empêcher.`
        : undefined,
    ).toEqual([]);
  });
});
