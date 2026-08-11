/**
 * Garde-fou sur le PRÉFIXE d'instructions des trois agents.
 *
 * Le préfixe système est réémis à CHAQUE aller-retour avec le modèle (2-3 fois
 * sur un flux avec appel d'outil), sous un plafond Groq de 12 000 tokens/minute.
 * Chaque token économisé ici est donc multiplié par le nombre d'allers-retours.
 *
 * Deux propriétés sont verrouillées :
 *   1. le bloc STYLE reste COURT — et partagé, pour n'avoir qu'un endroit à
 *      raccourcir la prochaine fois ;
 *   2. le raccourcissement n'a emporté aucune des consignes issues d'une
 *      régression réelle en production (tutoiement, mrkdwn, pas d'emojis, pas de
 *      « prochaines étapes », secret de l'identifiant interne, anti-invention).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { makeOnboardingOrchestrator } from '../../../src/features/onboarding/application/agents/onboarding-orchestrator';
import { makeQuestionnaireEngine } from '../../../src/features/questionnaire/application/agents/questionnaire-engine';
import { makeNotificationAgent } from '../../../src/features/notification/application/agents/notification-agent';
import { AGENT_STYLE_BLOCK, AGENT_ANTI_INVENTION_BLOCK } from '../../../src/shared/agent-style';

const CHARS_PER_TOKEN = 3.5;
const tok = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);

const agents = [
  ['onboardingOrchestrator', makeOnboardingOrchestrator],
  ['questionnaireEngine', makeQuestionnaireEngine],
  ['notificationAgent', makeNotificationAgent],
] as const;

async function instructionsOf(
  make: (tools: Record<string, never>) => { getInstructions: () => unknown },
) {
  return String(await make({}).getInstructions());
}

beforeEach(() => {
  vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
  vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Blocs partagés STYLE / ANTI-INVENTION', () => {
  it('tient le bloc STYLE sous 100 tokens', () => {
    // Mesure avant ce lot : ~170 tokens, répliqués dans chacun des 3 agents.
    const tokens = tok(AGENT_STYLE_BLOCK);
    expect(tokens, `bloc STYLE de ${tokens} tokens`).toBeLessThan(100);
  });

  it('conserve chaque consigne de style issue d une régression de production', () => {
    expect(AGENT_STYLE_BLOCK).toMatch(/tutoiement/i);
    expect(AGENT_STYLE_BLOCK).toContain('mrkdwn Slack');
    expect(AGENT_STYLE_BLOCK).toMatch(/markdown GitHub/i);
    expect(AGENT_STYLE_BLOCK).toMatch(/emoji/i);
    expect(AGENT_STYLE_BLOCK).toContain('prochaines étapes');
    expect(AGENT_STYLE_BLOCK).toContain('KISSO-AGENT-v3');
  });

  it('interdit explicitement d inventer une URL, un lien ou un chemin de fichier', () => {
    // Trou par lequel est passé le faux lien https://kisso.internal/docs/<uuid>/download.
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('URL');
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('lien');
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('chemin de fichier');
    // Sans régresser sur la liste d'origine.
    for (const champ of ['prénom', 'nom', 'email', 'identifiant', 'date', 'score']) {
      expect(AGENT_ANTI_INVENTION_BLOCK).toContain(champ);
    }
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('emailSent: false');
  });
});

describe.each(agents)('%s — instructions', (_id, make) => {
  it('reprend les blocs partagés STYLE et ANTI-INVENTION', async () => {
    const instructions = await instructionsOf(make as never);

    expect(instructions).toContain(AGENT_STYLE_BLOCK);
    expect(instructions).toContain(AGENT_ANTI_INVENTION_BLOCK);
  });

  it('ne conserve aucune variante locale du bloc STYLE', async () => {
    const instructions = await instructionsOf(make as never);
    // Une seule occurrence de « STYLE (Slack) » : la version partagée.
    expect(instructions.match(/STYLE \(Slack\)/g)).toHaveLength(1);
    expect(instructions.match(/RÈGLE ANTI-INVENTION/g)).toHaveLength(1);
  });
});

describe('onboardingOrchestrator — promesses de documents', () => {
  /**
   * `generateDocument` écrit une ligne en base et rend l'entité — rien d'autre.
   * Le SEUL producteur de PDF du dépôt est `PdfmakeService`, qui écrit sur le
   * disque local et rend un CHEMIN de fichier ; il est appelé par
   * `documentGenerationWorkflow`, jamais par un tool d'agent. Aucun upload Slack
   * n'existe (`files.upload` n'apparaît nulle part, et `files:write` ne fait pas
   * partie des scopes accordés au bot).
   *
   * Tant que cette chaîne n'est pas branchée, l'agent ne PEUT pas livrer de
   * fichier : c'est ce vide qui a produit le faux lien
   * `https://kisso.internal/docs/<uuid>/download`. Le jour où la livraison
   * existera, c'est cette consigne — et ce test — qu'il faudra mettre à jour.
   */
  it('énonce que generateDocument ne rend aucun fichier téléchargeable', async () => {
    const instructions = await instructionsOf(makeOnboardingOrchestrator as never);

    expect(instructions).toContain('generateDocument');
    expect(instructions).toMatch(/aucun fichier téléchargeable/i);
    expect(instructions).toMatch(/n'invente jamais de lien/i);
  });
});
