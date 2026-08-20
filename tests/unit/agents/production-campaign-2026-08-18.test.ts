import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { makeKnowledgeAgent } from '../../../src/features/knowledge/application/agents/knowledge-agent';
import { makeRecruitmentAgent } from '../../../src/features/recruitment/application/agents/recruitment-agent';
import { makeNotificationAgent } from '../../../src/features/notification/application/agents/notification-agent';
import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';

/**
 * ⚠️ Les clés LLM sont posées pour TOUT le fichier depuis le 2026-08-20 : `makeModelChain`
 * LÈVE quand aucun fournisseur n'est configuré, et les tests unitaires ne chargent pas
 * `.env`. Construire un agent sans clé, c'est construire un système non configuré — le
 * dire à la construction vaut mieux que le découvrir au premier message.
 */
beforeEach(() => {
  vi.stubEnv('GOOGLE_GEMINI_API_KEY', 'test-gemini-key');
  vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
  vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Les quatre défauts relevés par la CAMPAGNE DE PRODUCTION du 2026-08-18
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Huit messages réels, un par comportement, les quatre agents parcourus grâce au palier
 * collant. Trois sondes ont exposé un défaut qu'aucun test unitaire ne pouvait voir, parce
 * que chacun porte sur ce que le MODÈLE fait d'un tool-result correct.
 *
 * Ce fichier verrouille les consignes qui corrigent ces défauts. Il ne peut pas prouver que
 * le modèle obéira — aucun test ne le peut — mais il empêche la consigne de disparaître, ce
 * qui est déjà arrivé deux fois dans ce dépôt (la dérogation de rédaction posée sur
 * `sendNotification` et jamais reportée sur `generateDocument`, précisément le défaut P3).
 */

const instructionsOf = (agent: { getInstructions: () => unknown }): string =>
  String(agent.getInstructions());

describe('P6 — le knowledgeAgent affirmait une ABSENCE sur un échantillon', () => {
  /**
   * Mesuré en production : #kisso-hq porte 8 messages éligibles, `MAX_EXCERPTS` vaut 6, donc
   * `describeCoverage` a bien produit sa phrase et `wrapRetrievedContent` l'a placée en
   * préface — tout le mécanisme a fonctionné. Le modèle a quand même conclu « Aucun obstacle
   * concret n'est mentionné ».
   *
   * ⚠️ La consigne existait déjà et ne couvrait PAS ce cas : elle interdisait de « prétendre
   * résumer tout ce qui s'est dit », c'est-à-dire la surdéclaration POSITIVE. Le modèle a
   * commis la NÉGATIVE, qui est un acte de langage différent — et plus trompeur, parce qu'une
   * absence ne se vérifie pas. C'est la quatrième forme que prend ce défaut, après les deux
   * champs séparés ignorés (`coverage` puis `hint`) et la préface.
   */
  it('interdit explicitement d’affirmer qu’une chose n’a PAS été dite', () => {
    const text = instructionsOf(makeKnowledgeAgent({}));

    expect(text).toContain('ÉCHANTILLON');
    expect(text).toMatch(/n['’]affirme jamais qu['’]une chose n['’]a pas été dite/i);
  });
});

describe('P7 — le recruitmentAgent recopiait un FAUX aperçu au-dessus de la carte', () => {
  /**
   * La carte Block Kit porte le corps RÉEL, rendu par le gabarit, avec l'offset de fuseau —
   * elle est correcte, vérifié en production. L'agent en écrivait un SECOND au-dessus, de sa
   * propre plume : sujet différent, corps différent, offset absent.
   *
   * Ce n'est pas de la redondance, c'est une revue INVALIDE. Toute la feature repose sur
   * « un humain relit avant l'envoi » ; quelqu'un qui relit la prose et non la carte a
   * approuvé un texte qui ne partira pas. Et le corps est re-rendu au clic depuis les
   * champs, donc l'écart est structurel, pas accidentel.
   */
  it('interdit de recopier le sujet et le corps', () => {
    const text = instructionsOf(makeRecruitmentAgent({}));

    expect(text).toMatch(/ne recopie ni le sujet ni le corps/i);
  });

  it('continue d’interdire d’annoncer un envoi', () => {
    // Garde de non-régression : la réécriture ne doit pas emporter l'invariant d'origine.
    expect(instructionsOf(makeRecruitmentAgent({}))).toMatch(/ne dis jamais qu['’]il est parti/i);
  });
});

describe('P4 — « Le rappel a bien été enregistré » laisse croire à un envoi', () => {
  /**
   * Le tool est honnête : il rend `willBeSentAutomatically: false`. Le modèle ne l'a pas
   * relayé — et c'est exactement la leçon déjà payée DEUX FOIS sur la couverture des
   * extraits : **un champ séparé se lit comme une métadonnée, quel que soit son nom**.
   *
   * La personne lit « enregistré pour vendredi » et attend un rappel vendredi. Il n'existe
   * ni cron, ni poller, et `findPending()` n'a aucun site d'appel : rien ne partira jamais.
   * Même famille que `emailSent: false` sous `status: 'success'`.
   */
  it('impose de dire qu’aucun automate n’enverra le rappel', () => {
    const text = instructionsOf(makeNotificationAgent({}));

    expect(text).toMatch(/aucun automate/i);
  });
});

describe('P3 — generateDocument DEMANDAIT à l’humain d’écrire son propre guide', () => {
  /**
   * Le défaut le plus coûteux de la campagne, et le plus embarrassant : il était déjà
   * diagnostiqué et corrigé — ailleurs.
   *
   * Le 2026-08-11, le bilan de la série C (« 7 messages, 0 email, 0 rappel, 0 document ») a
   * établi que les outils POSAIENT les questions au lieu de faire le travail, et que la
   * dérogation devait vivre dans le `.describe()` du champ — jamais dans le prompt, où elle
   * contredirait frontalement `AGENT_ANTI_INVENTION_BLOCK` (« n'invente jamais une donnée
   * absente : demande-la »). La distinction qui tranche : un email ou un UUID se RETROUVENT,
   * une prose se PRODUIT.
   *
   * `sendNotification.body` a reçu `.describe('rédige-le, ne le demande pas')`. `title` et
   * `content` de `generateDocument` n'ont RIEN reçu — et la doctrine de l'époque citait
   * pourtant `generateDocument` comme le modèle à copier, ce qui a masqué l'oubli.
   *
   * Conséquence mesurée en production le 2026-08-18, sur « Génère-moi le guide d'accueil en
   * PDF » : « Quel texte doit contenir le guide d'accueil ? Fournis-moi le contenu… ». Un
   * aller-retour perdu — ≈ 1 500 tokens sur un budget qui en compte 100 000 par JOUR — et un
   * produit qui demande à un arrivant de rédiger lui-même son guide d'accueil.
   */
  // Le type public de `inputSchema` est le `StandardSchema` de Mastra, qui n'expose pas
  // `shape` : on relit donc l'objet Zod sous-jacent depuis `unknown`, comme le fait déjà
  // `tool-schema-flatness.test.ts`. La description est une donnée du schéma, pas du type.
  const schema = makeGenerateDocument({} as never).inputSchema as unknown as {
    shape: Record<string, { description?: string }>;
  };

  /**
   * ⚠️ Ces deux assertions portaient sur la CHAÎNE LITTÉRALE « rédige-le, ne le demande pas »
   * jusqu'au 2026-08-19. Elles verrouillaient donc une formulation, pas une propriété — et
   * cette formulation a été MESURÉE EN ÉCHEC une seconde fois le 2026-08-19, sur la même
   * phrase qu'en août 18 : « Peux-tu me fournir le contenu ? ». Cinq mots ne pèsent pas face à
   * `AGENT_ANTI_INVENTION_BLOCK` (« n'invente jamais une donnée absente : demande-la »), qui
   * vit dans le PROMPT et s'applique à tout.
   *
   * Le test vérifie désormais les deux moitiés de la dérogation, quelle qu'en soit la
   * rédaction : le champ dit que le modèle RÉDIGE, et qu'il ne DEMANDE JAMAIS.
   */
  it('dit au modèle de RÉDIGER le contenu, pas de le réclamer', () => {
    const d = schema.shape.content?.description ?? '';
    expect(d).toMatch(/rédige/i);
    expect(d).toMatch(/ne le demande (jamais|pas)/i);
  });

  it('dit la même chose du titre', () => {
    const d = schema.shape.title?.description ?? '';
    expect(d).toMatch(/rédige/i);
    expect(d).toMatch(/ne le demande (jamais|pas)/i);
  });

  it('n’a pas touché aux champs qui doivent RESTER des questions', () => {
    // `employeeId` est un identifiant : il se RETROUVE. Y poser une dérogation de rédaction
    // inviterait le modèle à en inventer un — exactement le bug de destinataire du
    // 2026-08-14, où dix documents ont été enregistrés sous le mauvais UUID.
    expect(schema.shape.employeeId?.description ?? '').not.toMatch(/rédige/i);
  });
});
