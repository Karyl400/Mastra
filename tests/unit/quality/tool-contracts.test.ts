import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  AGENT_TOOLS,
  TOOL_EFFECTS,
  allWiredTools,
  toolsWithEffect,
} from '../../../src/shared/agent-capabilities';
import { TOOL_REASONS, TOOL_REASON_ALIASES } from '../../../src/shared/tool-reasons';
import {
  ACTING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
} from '../../../src/features/notification/domain/services/claim-reconciliation';

const ROOT = resolve(__dirname, '../../..');
const FEATURES = join(ROOT, 'src/features');

function toolFiles(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const feature of readdirSync(FEATURES)) {
    const dir = join(FEATURES, feature, 'application/tools');
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      out.push({
        path: `src/features/${feature}/application/tools/${entry}`,
        source: readFileSync(join(dir, entry), 'utf8'),
      });
    }
  }
  return out;
}

function declaredToolIds(): string[] {
  return toolFiles()
    .flatMap(({ source }) => [...source.matchAll(/^\s{4}id: '([A-Za-z]+)',$/gm)])
    .map((m) => m[1])
    .sort();
}

/**
 * `docs/tool-design-audit.md` §6, dette n° 5 — `READ_ONLY_TOOL_NAMES` était une liste
 * RECOPIÉE. Elle a déjà été fausse : elle gardait `getTaskList` après son retrait et ignorait
 * `findPersonByName` et `findExpertise`, ajoutés le même jour. Le symptôme n'était pas une
 * erreur mais un SILENCE — la réconciliation FAIT/NARRATION se taisait sur le chemin le plus
 * fréquent du produit, un nom inconnu valant ACTEUR.
 *
 * La liste est désormais dérivée de `TOOL_EFFECTS`. Reste à garantir que `TOOL_EFFECTS` ne
 * puisse pas, lui, se désynchroniser du câblage : c'est l'objet du premier bloc.
 */
describe('TOOL_EFFECTS ne peut pas se désynchroniser du câblage', () => {
  it('déclare exactement les outils câblés — ni plus, ni moins', () => {
    expect(Object.keys(TOOL_EFFECTS).sort()).toEqual([...allWiredTools()]);
  });

  it('le câblage ne nomme que des outils qui existent réellement dans src/', () => {
    // Le sens qui manquait : `AGENT_TOOLS` pouvait nommer un outil supprimé. Ce dépôt a connu
    // des instructions d'agent citant `discoverSlackWorkspace` et `createEmployee` longtemps
    // après leur retrait.
    expect([...allWiredTools()]).toEqual(declaredToolIds());
  });

  it('la partition lecture / écriture est exhaustive et disjointe', () => {
    expect(toolsWithEffect('read').length + toolsWithEffect('write').length).toBe(
      allWiredTools().length,
    );
  });

  it('les deux ensembles de la réconciliation EN DÉRIVENT, ils ne sont plus recopiés', () => {
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual([...toolsWithEffect('read')]);
    expect([...ACTING_TOOL_NAMES].sort()).toEqual([...toolsWithEffect('write')]);
  });

  it('le nom d’un outil de lecture ne commence jamais par un préfixe d’écriture', () => {
    // Les deux quarantaines (`outbound-tool-quarantine`, `read-tool-quarantine`) raisonnent sur
    // des PRÉFIXES de nom. Elles restent utiles — un préfixe est dérivé, il ne se périme pas —
    // mais elles ne valent que si le nommage et l'effet déclaré s'accordent. Un outil nommé
    // `archiveChannelDigest` mais déclaré `read` passerait les gardes ET mentirait ici.
    const writePrefixes = ['send', 'post', 'publish', 'upload', 'generate', 'update', 'delete'];
    for (const name of toolsWithEffect('read')) {
      const offender = writePrefixes.find((p) => name.toLowerCase().startsWith(p));
      expect(offender, `${name} est déclaré 'read' mais porte le préfixe '${offender}'`).toBe(
        undefined,
      );
    }
  });

  it('chaque agent du registre a au moins un outil', () => {
    for (const [agentId, tools] of Object.entries(AGENT_TOOLS)) {
      expect(tools.length, `${agentId} n'a aucun outil`).toBeGreaterThan(0);
    }
  });
});

/**
 * `docs/tool-design-audit.md` §3, dette n° 7 — 21 codes de `reason` répartis sur 13 fichiers,
 * qu'aucune union ne déclarait et qu'aucun test n'énumérait. Un outil pouvait rendre
 * `reason: 'not_fond'` et rester vert : ces codes sont lus en PROSE par le modèle, jamais par
 * du code, donc rien ne pouvait échouer.
 *
 * ⚠️ On ne renomme PAS les cinq synonymes. `person_not_found` / `recipient_not_found` /
 * `employee_not_found` disent la même chose sous trois noms, mais ces chaînes traversent la
 * fenêtre du modèle : les unifier change ce que l'agent lit, donc son comportement, pour un
 * gain de propreté. Ils sont DÉCLARÉS comme alias — la dette est nommée, pas payée en aveugle.
 */
describe('le vocabulaire de `reason` est clos', () => {
  /**
   * ⚠️ **LA PREMIÈRE VERSION DE CE SCAN ÉTAIT UN FAUX VERT**, et c'est la leçon du lot.
   *
   * Elle cherchait `reason: '…'`, c'est-à-dire l'affectation littérale directe, et déclarait le
   * vocabulaire clos sur 21 codes. Trois codes réels lui échappaient parce qu'ils ne sont pas
   * écrits sous cette forme :
   *
   *   `reason: missingScope ? 'missing_scope' : fallback.reason`   (generate-document)
   *   `reason: partial ? 'partial_search' : 'no_match'`            (find-expertise)
   *   `const reason: ChannelUnavailableReason = … 'unavailable'`   (get-channel-history)
   *
   * Un scan qui ne voit pas ce qu'il prétend couvrir est pire qu'aucun scan : il fait croire à
   * une garantie. Le motif prend donc TOUT ce qui suit `reason:` ou `reason =` jusqu'au
   * séparateur, ternaires compris.
   *
   * ⚠️ **CE QUI RESTE HORS PORTÉE L'EST À DESSEIN** : les codes qui transitent par une union de
   * TYPES (`ChannelVerdict`, `SearchVerdict`, `MemoryVerdict`, `DisclosureReason`) apparaissent
   * ici sous la forme `reason: verdict.reason` et ne livrent aucun littéral. Ils n'en ont pas
   * besoin — `tsc` interdit déjà à une valeur d'en sortir. Ce test couvre exactement ce que le
   * compilateur ne couvre pas : les littéraux nus.
   */
  const literals = [
    ...new Set(
      toolFiles()
        .flatMap(({ source }) => [
          ...source.matchAll(/\breason(?:\s*:\s*|\s*=\s*)((?:[^,;\n}]|'[^']*')*)/g),
        ])
        .flatMap((m) => [...m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)])
        .map((m) => m[1]),
    ),
  ].sort();

  it('le scan trouve effectivement des codes (anti faux-négatif)', () => {
    expect(literals.length).toBeGreaterThan(20);
  });

  it('tout code employé dans un outil est déclaré', () => {
    const undeclared = literals.filter(
      (code) => !(TOOL_REASONS as readonly string[]).includes(code),
    );
    expect(
      undeclared,
      `Codes de \`reason\` absents de TOOL_REASONS : ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('tout code déclaré est employé quelque part — la liste ne peut pas enfler', () => {
    const unused = TOOL_REASONS.filter((code) => !literals.includes(code));
    expect(unused, `Codes déclarés que plus aucun outil n'emploie : ${unused.join(', ')}`).toEqual(
      [],
    );
  });

  it('les alias déclarés pointent vers un code canonique existant', () => {
    for (const [alias, canonical] of Object.entries(TOOL_REASON_ALIASES)) {
      expect(TOOL_REASONS).toContain(alias);
      expect(TOOL_REASONS).toContain(canonical);
      expect(alias).not.toBe(canonical);
    }
  });
});
