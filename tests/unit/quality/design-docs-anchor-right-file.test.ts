import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const DOCS = join(ROOT, 'docs/conception');

/*
 * ════════════════════════════════════════════════════════════════════════════
 * Une entrée est-elle rangée sous le fichier qui porte VRAIMENT son code ?
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `design-docs-anchor-real-code.test.ts` garde qu'une ancre désigne du code VIVANT. Il dit
 * lui-même ce qu'il ne fait pas : « Il ne vérifie pas le FICHIER. Une déclaration DÉPLACÉE d'un
 * fichier à l'autre passe donc au vert alors que sa page la range toujours au mauvais endroit. »
 * C'est ce trou-là que ce fichier ferme.
 *
 * ⚠️ Il a été écrit le 2026-08-28, le jour où la découpe de `src/` en fichiers de 200 lignes a
 * fait passer les entrées MAL RANGÉES de 12 à 700 — **sans qu'aucun test ne rougisse**. Le
 * déplacement de code est exactement le geste qui produit cette dérive, et c'est un geste
 * courant. Une page qui range une décision sous un fichier qui ne la porte plus envoie son
 * lecteur au mauvais endroit : premier degré de la dérive documentaire que ce dépôt a comptée
 * onze fois le 2026-08-20.
 *
 * ─── CE QUI EST DÉLIBÉRÉMENT HORS DE PORTÉE ──────────────────────────────────────────────
 *
 * — **Les ancres AMBIGUËS.** `return {` ou `tools: {},` existent dans des dizaines de fichiers ;
 *   aucune attribution ne peut en être déduite. On ne les compte ni comme justes ni comme
 *   fausses — les inventer serait pire que de les ignorer.
 * — **Les ancres ORPHELINES.** Elles ne désignent aucun fichier, donc la question du bon fichier
 *   ne se pose pas. C'est le test voisin qui les tient, avec sa liste de dette qui ne peut que
 *   rétrécir. Les compter ici les ferait rougir DEUX fois pour un seul défaut.
 *
 * La normalisation est la MÊME que celle du test voisin, et pour la même raison : Prettier
 * reformate les déclarations, donc on compare des formes sans blancs. Elle est recopiée plutôt
 * qu'importée parce qu'un test ne doit pas dépendre d'un autre test — mais si l'une change,
 * l'autre doit changer.
 */

function normalize(code: string): string {
  let out = code.replace(/\s+/g, '').replace(/['"`]/g, '"');
  let previous: string;
  do {
    previous = out;
    out = out.replace(/,(?=[)\]}>])/g, '');
  } while (out !== previous);
  return out.replace(/,+$/, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SRC = join(ROOT, 'src');

const SOURCES = walk(SRC).map((file) => ({
  path: file.slice(SRC.length + 1),
  normalized: normalize(readFileSync(file, 'utf8')),
}));

/** Une ancre trop courte désigne trop de choses : elle n'apprend rien. */
const MIN_ANCHOR_LENGTH = 12;

const HEADING = /^#{2,3}\s+`([^`]+\.ts)`/;
const ANCHOR = /^\*\*Avant\s+`(.+)`\*\*$/;

interface Verdict {
  readonly page: string;
  readonly line: number;
  readonly titled: string;
  readonly actual: string;
}

function audit(): { misfiled: Verdict[]; resolved: number; ambiguous: number } {
  const misfiled: Verdict[] = [];
  let resolved = 0;
  let ambiguous = 0;

  for (const page of readdirSync(DOCS).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    const lines = readFileSync(join(DOCS, page), 'utf8').split('\n');
    let heading: string | null = null;

    lines.forEach((line, index) => {
      const title = HEADING.exec(line);
      if (title) {
        heading = title[1]!.replace(/^src\//, '');
        return;
      }

      const anchor = ANCHOR.exec(line);
      if (!anchor || heading === null) return;

      const needle = normalize(anchor[1]!);
      if (needle.length < MIN_ANCHOR_LENGTH) {
        ambiguous += 1;
        return;
      }

      const holders = SOURCES.filter((f) => f.normalized.includes(needle));
      if (holders.length !== 1) {
        ambiguous += 1;
        return;
      }

      resolved += 1;
      if (holders[0]!.path !== heading) {
        misfiled.push({ page, line: index + 1, titled: heading, actual: holders[0]!.path });
      }
    });
  }

  return { misfiled, resolved, ambiguous };
}

describe('chaque entrée de docs/conception/ est rangée sous le BON fichier', () => {
  const { misfiled, resolved } = audit();

  it('aucune entrée ne survole un fichier qui ne porte pas son code', () => {
    expect(
      misfiled.map((v) => `${v.page}:${v.line} titré \`${v.titled}\`, en réalité \`${v.actual}\``),
      misfiled.length
        ? 'Une décision rangée sous un fichier qui ne la porte plus envoie son lecteur au ' +
            'mauvais endroit. Corrige le titre `## `chemin`` qui surplombe l’entrée, ou déplace ' +
            'l’entrée sous le bon titre — jamais l’inverse : c’est le CODE qui fait foi.'
        : undefined,
    ).toEqual([]);
  });

  it('a réellement attribué des ancres — anti-faux-négatif', () => {
    // Sans ce contrôle, une normalisation cassée rendrait tout « ambigu » et le test ci-dessus
    // serait vert en n'ayant rien vérifié. C'est exactement la panne mesurée sur
    // `claimed-invariants` le 2026-08-28 : des contrôles positifs qui prouvaient que des
    // FICHIERS étaient lus, jamais qu'une AFFIRMATION avait été trouvée.
    expect(resolved).toBeGreaterThan(1000);
  });

  it('reconnaît un mauvais rangement — anti-faux-négatif', () => {
    const anywhere = SOURCES.some((f) => f.normalized.includes(normalize('export function')));
    expect(anywhere).toBe(true);
  });
});
