import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AGENT_TOOLS } from '../../../src/shared/agent-capabilities';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `AGENT_TOOLS` DIT-IL LA VÉRITÉ SUR LE CÂBLAGE RÉEL ?
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `CLAUDE.md` affirme qu'`agent-capabilities.ts` déclare le câblage agent → outils « UNE SEULE
 * FOIS ». L'audit du 2026-08-21 a mesuré le contraire : il y en avait **trois** copies —
 * `src/mastra/index.ts` (le seul qui compte, c'est lui qui construit les agents), `AGENT_TOOLS`,
 * et `KNOWN_AGENT_IDS`. La troisième est désormais dérivée de la deuxième. Reste à confronter
 * la deuxième à la PREMIÈRE.
 *
 * ⚠️ **Le test qui prétendait le faire comparait la table à elle-même** :
 * `agent-instructions-budget.test.ts:62` fait `const WIRING = AGENT_TOOLS`. Il n'a jamais pu
 * détecter quoi que ce soit — c'est le contrôle anti-faux-négatif qui manquait, sous sa forme
 * la plus pure.
 *
 * ⚠️ **CE QUE COÛTE LA DIVERGENCE.** `AGENT_TOOLS` n'est pas un chiffre décoratif : le ROUTAGE
 * s'en sert (`agentHasTool`) pour décider si le palier thématique peut DÉLOGER un fil collant.
 * Un outil déplacé d'un agent à l'autre dans `index.ts` sans mise à jour de la table ferait
 * router un message vers un agent qui ne porte pas l'outil exigé — exactement le défaut du
 * 2026-08-12, que le routage par capacité existe pour empêcher. Rien ne rougirait.
 *
 * ⚠️ **POURQUOI UNE LECTURE STATIQUE plutôt qu'un import.** Importer `src/mastra/index.ts`
 * ouvrirait des connexions, lèverait sans `DATABASE_URL` et instancierait tout le graphe. On
 * lit donc le fichier — même technique que `guards-are-mounted.test.ts`. Ce test ne prouve pas
 * que les agents fonctionnent ; il prouve que les deux listes disent la même chose, ce qu'aucun
 * type ne peut exprimer.
 */

const WIRING_FILE = resolve(__dirname, '../../..', 'src/mastra/index.ts');

/**
 * Extrait `{ agentId: [outils] }` des appels `const <id> = make<Agent>({ … })` de `index.ts`.
 *
 * Volontairement littéral : on ne lit que les clés en forme abrégée (`findExpertise,`), qui est
 * la façon dont ce fichier câble ses outils. Une clé écrite `foo: bar` serait ignorée — si ce
 * style apparaissait un jour, l'assertion de non-vacuité ci-dessous le rendrait visible plutôt
 * que de laisser le test se taire.
 */
function wiringFromIndex(): Record<string, string[]> {
  const source = readFileSync(WIRING_FILE, 'utf-8');
  const found: Record<string, string[]> = {};

  for (const match of source.matchAll(/const (\w+) = make(\w+)\(\{([^}]*)\}\)/g)) {
    const id = match[1]!;
    if (!Object.hasOwn(AGENT_TOOLS, id)) continue;
    found[id] = match[3]!
      .split(',')
      .map((chunk) => chunk.replace(/\/\/[^\n]*/g, '').trim())
      .filter((chunk) => /^\w+$/.test(chunk));
  }

  // Forme sur une seule ligne : `const recruitmentAgent = makeRecruitmentAgent({ x });`
  return found;
}

describe('le câblage agent → outils', () => {
  const actual = wiringFromIndex();

  it('est trouvable dans src/mastra/index.ts — sinon ce test serait vert et vide', () => {
    // Le contrôle anti-faux-négatif, celui qui manquait précisément au test d'origine.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(AGENT_TOOLS).sort());
  });

  it.each(Object.keys(AGENT_TOOLS))('%s : AGENT_TOOLS dit ce que index.ts câble', (agentId) => {
    const declared = [...AGENT_TOOLS[agentId]!].sort();
    const wired = [...(actual[agentId] ?? [])].sort();

    expect(
      wired,
      `AGENT_TOOLS et src/mastra/index.ts divergent sur ${agentId}. ` +
        `Le ROUTAGE lit AGENT_TOOLS (agentHasTool) pour décider si le palier thématique peut ` +
        `déloger un fil : une divergence route vers un agent qui ne porte pas l'outil exigé, ` +
        `et rien d'autre ne le signalerait.`,
    ).toEqual(declared);
  });
});
