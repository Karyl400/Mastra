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
/**
 * Les identifiants réellement enregistrés dans `agents: { … }` de `index.ts`.
 *
 * C'est l'autorité : la clé du registre DOIT être identique à l'`id` de l'agent, et c'est elle
 * que `mastra.getAgent(id)` résout. Un agent absent d'ici n'existe pas ; un agent présent ici
 * et absent d'`AGENT_TOOLS` est routable et invisible aux détecteurs.
 */
function registeredAgentIds(source: string): Set<string> {
  const block = source.slice(source.indexOf('agents: {'), source.indexOf('workflows: {'));
  return new Set(
    block
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => /^\w+$/.test(line)),
  );
}

function wiringFromIndex(): Record<string, string[]> {
  const source = readFileSync(WIRING_FILE, 'utf-8');
  const found: Record<string, string[]> = {};

  const registered = registeredAgentIds(source);

  for (const match of source.matchAll(/const (\w+) = make(\w+)\(\{([^}]*)\}\)/g)) {
    const id = match[1]!;
    // ⚠️ Ce filtre portait sur `AGENT_TOOLS`, et c'était un désarmement : un agent CÂBLÉ mais
    // absent de cette table était silencieusement ignoré, donc invisible aux trois détecteurs
    // qu'elle gouverne — routage par capacité, `READ_ONLY_TOOL_NAMES`, réconciliation
    // FAIT/NARRATION. Le test ne pouvait voir qu'un agent MANQUANT, jamais un agent EN TROP
    // (audit du 2026-08-28, § 2.4). Il porte désormais sur le REGISTRE `agents: {}`, qui est
    // ce que `mastra.getAgent(id)` résout — la seule autorité sur « est-ce un agent ? ».
    if (!registered.has(id)) continue;
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

  it('tout agent ENREGISTRÉ a son entrée dans AGENT_TOOLS', () => {
    // ⚠️ L'assertion qui manquait vraiment. Filtrer sur le registre ne suffit PAS : un agent
    // enregistré sans appel `const x = makeX({ … })` n'entrait dans aucun des deux ensembles
    // comparés, donc il restait invisible. Vérifié par mutation — insérer `fauxAgent` dans
    // `agents: {}` laissait la suite verte AVANT cette ligne, et la fait rougir depuis.
    //
    // C'est la table qui gouverne le routage par capacité, `READ_ONLY_TOOL_NAMES` et la
    // réconciliation FAIT/NARRATION. Un agent qui lui échappe est routable et invisible aux
    // trois détecteurs à la fois.
    const registered = [...registeredAgentIds(readFileSync(WIRING_FILE, 'utf-8'))];
    const unknown = registered.filter((id) => !Object.hasOwn(AGENT_TOOLS, id));

    expect(
      unknown,
      unknown.length
        ? `Agent(s) enregistré(s) dans \`agents: {}\` et absent(s) d'AGENT_TOOLS : ` +
            `${unknown.join(', ')}. Ils seraient routables et invisibles au routage par ` +
            `capacité, à READ_ONLY_TOOL_NAMES et à la réconciliation FAIT/NARRATION.`
        : undefined,
    ).toEqual([]);
  });

  it('est trouvable dans src/mastra/index.ts — sinon ce test serait vert et vide', () => {
    // Le contrôle anti-faux-négatif, celui qui manquait précisément au test d'origine.
    // ⚠️ Il compare désormais les deux sens : un agent enregistré sans entrée dans
    // `AGENT_TOOLS` fait rougir, alors qu'il était silencieusement sauté auparavant.
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
