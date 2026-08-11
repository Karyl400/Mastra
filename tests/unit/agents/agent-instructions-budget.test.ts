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
 *      « prochaines étapes », pas de récitation de capacités, secret de
 *      l'identifiant interne, anti-invention).
 *
 * ⚠️ Sur le point 2, une protection a CHANGÉ DE SUPPORT le 2026-08-11 sans être
 * abandonnée : « pas de markdown GitHub » et « pas d'emojis » ne sont plus dans
 * le texte du bloc, ils sont désormais garantis par `sanitizeAgentOutput`, point
 * de passage unique de toute réponse d'agent. L'assertion correspondante a donc
 * été RÉÉCRITE sur le code, pas supprimée — sans quoi la protection pourrait
 * disparaître des deux côtés à la fois sans qu'aucun test ne rougisse.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { makeOnboardingOrchestrator } from '../../../src/features/onboarding/application/agents/onboarding-orchestrator';
import { makeQuestionnaireEngine } from '../../../src/features/questionnaire/application/agents/questionnaire-engine';
import { makeNotificationAgent } from '../../../src/features/notification/application/agents/notification-agent';
import { AGENT_STYLE_BLOCK, AGENT_ANTI_INVENTION_BLOCK } from '../../../src/shared/agent-style';
import { sanitizeAgentOutput } from '../../../src/shared/security/agent-output';

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
    // Mesure avant le premier dégraissage : ~170 tokens, répliqués dans chacun des
    // 3 agents. Après : 81. Aujourd'hui 86 — le budget repris au formatage (voir le
    // test suivant) a été redéployé sur le ton, il n'a pas été rendu.
    const tokens = tok(AGENT_STYLE_BLOCK);
    expect(tokens, `bloc STYLE de ${tokens} tokens`).toBeLessThan(100);
  });

  it('conserve chaque consigne de style issue d une régression de production', () => {
    expect(AGENT_STYLE_BLOCK).toMatch(/tutoiement/i);
    expect(AGENT_STYLE_BLOCK).toContain('prochaines étapes');
    // Les réponses de production récitaient des listes de capacités avant de répondre.
    // Aucun filtre de sortie ne sait corriger cela : seul le texte le peut.
    expect(AGENT_STYLE_BLOCK).toMatch(/réciter/i);
    expect(AGENT_STYLE_BLOCK).toContain('KISSO-AGENT-v3');
  });

  /**
   * Ancienne assertion : le bloc STYLE devait CONTENIR « mrkdwn Slack », « markdown
   * GitHub » et « emoji ». Ces trois consignes ont quitté le texte le 2026-08-11 —
   * pas la protection.
   *
   * Le déplacement est justifié : une instruction ne peut que DEMANDER au modèle de
   * ne pas produire de markdown GitHub, et la campagne du 2026-08-10 a montré qu'il
   * en produisait malgré l'interdiction explicite. `sanitizeAgentOutput` le
   * GARANTIT, au point de passage unique de toute réponse d'agent.
   *
   * L'assertion est donc réécrite ici même, et pas seulement déléguée à
   * `tests/unit/security/agent-output.test.ts` : c'est ce qui empêche qu'un futur
   * allègement de `sanitizeAgentOutput` fasse disparaître la règle des DEUX supports
   * à la fois, sans qu'aucun test de style ne rougisse.
   */
  it('délègue au code la conversion mrkdwn et le retrait des emojis', () => {
    const cleaned = sanitizeAgentOutput('## Bilan\n\n**Fait** :wave: et livré 🎉\n\n---\n');

    expect(cleaned.text).toContain('*Bilan*');
    expect(cleaned.text).toContain('*Fait*');
    expect(cleaned.text).not.toContain('**');
    expect(cleaned.text).not.toContain(':wave:');
    expect(cleaned.text).not.toContain('🎉');
    expect(cleaned.text).not.toContain('---');
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
    // Une seule ouverture de bloc STYLE : la version partagée. Le motif est ancré en
    // début de ligne et tolère l'ancien libellé « STYLE (Slack) » comme le nouveau
    // « STYLE : » — ce qui compte est le NOMBRE d'ouvertures, pas leur formulation :
    // une seconde signalerait le retour d'une variante recopiée dans un agent.
    expect(instructions.match(/^STYLE\b/gm)).toHaveLength(1);
    expect(instructions.match(/RÈGLE ANTI-INVENTION/g)).toHaveLength(1);
  });
});

/**
 * Le bloc DOCUMENTS a été RÉÉCRIT le 2026-08-11 — et ces assertions avec lui.
 *
 * Il disait : « generateDocument ENREGISTRE le document ; il ne renvoie AUCUN fichier
 * téléchargeable ni URL (l'envoi d'un PDF n'est pas encore branché) ». C'était le constat
 * exact d'un vide fonctionnel : aucun tool d'agent ne produisait de fichier, et c'est ce
 * vide qui a fabriqué le faux lien `https://kisso.internal/docs/<uuid>/download`.
 *
 * Le vide est comblé : `generateDocument` rend un PDF ou un DOCX, l'uploade dans le fil
 * Slack ou l'envoie en pièce jointe, et rend un verdict de livraison. L'ancienne
 * assertion (« aucun fichier téléchargeable ») ne pouvait donc PAS être conservée sans
 * verrouiller une consigne devenue fausse, qui aurait bridé la capacité.
 *
 * Ce qui la remplace couvre les mêmes risques, sur les faits nouveaux :
 *   • l'interdiction d'inventer un lien reste, mot pour mot — le fichier est livré par
 *     UPLOAD, aucune URL de téléchargement n'existe dans ce système ;
 *   • l'agent doit LIRE le verdict `delivery` au lieu de supposer, seule façon de dire
 *     « le document est prêt mais je n'ai pas pu te l'envoyer » quand le scope
 *     `files:write` manque encore ;
 *   • le budget est mesuré, pas estimé.
 */
describe('onboardingOrchestrator — promesses de documents', () => {
  /** Longueur du bloc avant réécriture (2 lignes, 203 caractères ≈ 58 tokens). */
  const ANCIEN_BLOC_CHARS = 203;

  async function documentsBlock() {
    const instructions = await instructionsOf(makeOnboardingOrchestrator as never);
    const bloc = instructions.match(/^DOCUMENTS :.*$/m);
    expect(bloc, 'bloc DOCUMENTS introuvable dans les instructions').not.toBeNull();
    return bloc![0];
  }

  it('décrit la capacité réelle : un fichier rendu ET livré', async () => {
    const bloc = await documentsBlock();

    expect(bloc).toContain('generateDocument');
    expect(bloc).toMatch(/pdf/i);
    expect(bloc).toMatch(/docx/i);
    expect(bloc).toMatch(/deliverTo/);
    expect(bloc).toMatch(/slack/i);
    expect(bloc).toMatch(/email/i);
  });

  it('fait reposer l annonce sur le verdict de livraison, pas sur une supposition', async () => {
    const bloc = await documentsBlock();

    expect(bloc).toContain('delivery');
    // « prêt mais non livré » est l'énoncé honnête quand `files:write` manque encore.
    expect(bloc).toMatch(/non livré/i);
  });

  it('conserve mot pour mot l interdiction d inventer un lien', async () => {
    // Le fichier arrive par upload : il n'existe AUCUNE URL de téléchargement à citer.
    expect(await documentsBlock()).toMatch(/n'invente jamais de lien/i);
  });

  it('ne coûte pas plus cher que le bloc qu il remplace', async () => {
    const bloc = await documentsBlock();
    const tokens = Math.round(bloc.length / CHARS_PER_TOKEN);

    expect(
      bloc.length,
      `bloc DOCUMENTS de ${bloc.length} caractères (${tokens} tokens), contre ` +
        `${ANCIEN_BLOC_CHARS} avant réécriture`,
    ).toBeLessThanOrEqual(ANCIEN_BLOC_CHARS);
  });
});
