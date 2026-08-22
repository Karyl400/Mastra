import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Agent } from '@mastra/core/agent';

import { makeOnboardingOrchestrator } from '../../../src/features/onboarding/application/agents/onboarding-orchestrator';
import { makeNotificationAgent } from '../../../src/features/notification/application/agents/notification-agent';
import { makeKnowledgeAgent } from '../../../src/features/knowledge/application/agents/knowledge-agent';
import { makeRecruitmentAgent } from '../../../src/features/recruitment/application/agents/recruitment-agent';
import { ModelFactSummarizer } from '../../../src/features/knowledge/infrastructure/services/model-fact-summarizer.service';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CHAQUE AGENT PORTE LE GARDE-FOU, ET LA LISTE EST DÉRIVÉE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ TROUVÉ PAR MUTATION LE 2026-08-22. En remplaçant `buildAgentInstructions(…)` par
 * l'identité, agent par agent : trois constructeurs faisaient rougir la suite, **deux la
 * laissaient entièrement verte** — `recruitmentAgent` et l'agent du rideau à faits.
 *
 * Ce sont les deux plus exposés. `recruitmentAgent` est le seul qui écrive vers une adresse
 * HORS de l'entreprise ; `factCurtain` est le seul dont l'entrée soit du texte Slack de tiers
 * non filtré. Retirer tout le garde-fou anti prompt-injection de l'un ou l'autre ne cassait
 * aucun test.
 *
 * ⚠️ LA CAUSE ÉTAIT LA FORME, PAS L'OUBLI : les assertions étaient RECOPIÉES par agent, dans
 * le fichier de test de chaque agent. Une liste écrite à la main ne couvre que ce que son
 * auteur a pensé à y mettre, et jamais l'agent ajouté demain. C'est le motif que ce dépôt
 * combat partout ailleurs — `AGENT_TOOLS`, `agentToolBoundary`, `guards-are-mounted`.
 *
 * Ce test DÉRIVE donc la liste des fichiers qui construisent des instructions d'agent, et
 * exige que chacun soit réellement exercé ci-dessous.
 */

const ROOT = resolve(__dirname, '../../..');

const SECURITY_HEADER = '[SECURITY_ID:';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Les fichiers de `src/` qui fabriquent des instructions d'agent — le module qui les produit exclu. */
function filesBuildingAgentInstructions(): string[] {
  return walk(join(ROOT, 'src'))
    .filter((file) => readFileSync(file, 'utf8').includes('buildAgentInstructions('))
    .map((file) => file.slice(ROOT.length + 1))
    .filter((file) => file !== 'src/shared/security/llm-guardrail.ts')
    .sort();
}

async function instructionsOf(agent: Pick<Agent, 'getInstructions'>): Promise<string> {
  return String(await agent.getInstructions());
}

/** Le sommateur construit son agent en champ PRIVÉ : on l'atteint pour mesurer le CÂBLAGE réel. */
function factCurtainAgent(): Pick<Agent, 'getInstructions'> {
  const summarizer = new ModelFactSummarizer();
  return (summarizer as unknown as { agent: Pick<Agent, 'getInstructions'> }).agent;
}

const EXERCISED: ReadonlyArray<readonly [string, () => Pick<Agent, 'getInstructions'>]> = [
  [
    'src/features/onboarding/application/agents/onboarding-orchestrator.ts',
    () => makeOnboardingOrchestrator({}),
  ],
  [
    'src/features/notification/application/agents/notification-agent.ts',
    () => makeNotificationAgent({}),
  ],
  ['src/features/knowledge/application/agents/knowledge-agent.ts', () => makeKnowledgeAgent({})],
  [
    'src/features/recruitment/application/agents/recruitment-agent.ts',
    () => makeRecruitmentAgent({}),
  ],
  [
    'src/features/knowledge/infrastructure/services/model-fact-summarizer.service.ts',
    factCurtainAgent,
  ],
];

describe('le garde-fou de sécurité est en tête des instructions de CHAQUE agent', () => {
  it.each(EXERCISED.map(([file, build]) => [file, build] as const))('%s', async (_file, build) => {
    const instructions = await instructionsOf(build());

    expect(instructions.trimStart().startsWith(SECURITY_HEADER)).toBe(true);
  });

  it('les placeholders sont réellement substitués partout', async () => {
    for (const [, build] of EXERCISED) {
      const instructions = await instructionsOf(build());

      expect(instructions).not.toContain('{DELIMITER_PREFIX}');
      expect(instructions).not.toContain('[[SESSION_MARKER]]');
    }
  });

  it('⚠️ AUCUN constructeur d’instructions n’échappe à ce test — liste DÉRIVÉE de src/', () => {
    const exercised = EXERCISED.map(([file]) => file).sort();
    const found = filesBuildingAgentInstructions();

    expect(
      found,
      `Un module fabrique des instructions d'agent sans être exercé ici.\n` +
        `Trouvés dans src/ : ${found.join(', ')}\n` +
        `Exercés par ce test : ${exercised.join(', ')}\n` +
        `Ajouter le constructeur manquant à EXERCISED — sans quoi son garde-fou ` +
        `anti prompt-injection pourrait disparaître sans faire rougir un seul test.`,
    ).toEqual(exercised);
  });

  it('scanne effectivement src/ — anti faux-négatif', () => {
    expect(walk(join(ROOT, 'src')).length).toBeGreaterThan(150);
    expect(filesBuildingAgentInstructions().length).toBeGreaterThanOrEqual(5);
  });
});
