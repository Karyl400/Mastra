import { describe, it, expect } from 'vitest';

import { buildChannelRedirectNotice } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';

/**
 * ⚠️ **LE MODÈLE PROPOSAIT UN CONTOURNEMENT, ALORS QUE LE PROMPT LE LUI INTERDISAIT.**
 *
 * Mesuré en production le 2026-08-21 : « Récapitule `<#CMLKC4S5T>` et envoie-le-moi en PDF »
 * contient `pdf`, donc part chez `onboardingOrchestrator` — qui ne porte pas `getChannelHistory`.
 * Son refus était CORRECT (la quarantaine §4.2 tient : aucun agent ne réunit lecture agrégée et
 * écriture externe). Mais il a répondu « transmets-moi le texte, je ferai le PDF et je
 * l'enverrai à <adresse> » : un contournement proposé, et une adresse email annoncée sans qu'on
 * la demande.
 *
 * Le bloc DOCUMENTS de son prompt dit pourtant « Rédige `content` TOI-MÊME, ne le demande
 * jamais ». Sixième consigne mesurée en échec sur ce dépôt. **Une consigne est PROBABLE, le
 * code est GARANTI** — d'où une note déterministe plutôt qu'une phrase de plus.
 */
describe('buildChannelRedirectNotice', () => {
  const ASKED = 'Récapitule <#CMLKC4S5T|kisso-hq> et envoie-le-moi en PDF par email.';
  const REFUSAL = "Je n'ai pas accès à l'historique de ce canal.";

  it("indique où la demande aboutit quand l'agent ne sait pas lire un canal", () => {
    const notice = buildChannelRedirectNotice(ASKED, 'onboardingOrchestrator', REFUSAL);

    expect(notice).toContain('demande-le seul');
    expect(notice).toContain('recopier');
  });

  it("se tait quand l'agent SAIT lire un canal — dérivé du câblage, pas d'une liste", () => {
    // `knowledgeAgent` porte `getChannelHistory` : il n'y a rien à rediriger. Le jour où cet
    // outil change d'agent, cette décision suit toute seule.
    expect(buildChannelRedirectNotice(ASKED, 'knowledgeAgent', REFUSAL)).toBe('');
  });

  it('se tait sans jeton de canal — la note ne doit pas devenir du bruit', () => {
    expect(
      buildChannelRedirectNotice('Fais-moi un PDF du guide', 'onboardingOrchestrator', REFUSAL),
    ).toBe('');
  });

  it('se tait si la réponse dit DÉJÀ la bonne chose', () => {
    // Anti-doublon : accoler une correction à une réponse juste est du bruit, et ce dépôt
    // applique déjà cette règle au nom du destinataire (`textMentionsName`).
    const bonneReponse = 'Je ne lis pas les canaux — demande-moi le résumé seul et je m’en occupe.';
    expect(buildChannelRedirectNotice(ASKED, 'onboardingOrchestrator', bonneReponse)).toBe('');
  });

  it('reconnaît la forme `<#C…>` sans libellé', () => {
    expect(
      buildChannelRedirectNotice('Résume <#CMLKC4S5T> en PDF', 'onboardingOrchestrator', REFUSAL),
    ).not.toBe('');
  });

  it('est du mrkdwn Slack, jamais du markdown GitHub', () => {
    // Les textes en dur ne passent par AUCUN filtre : `sanitizeAgentOutput` n'a qu'un seul site
    // d'appel, `response.text`. Un `**gras**` s'afficherait littéralement — constaté le 2026-08-18.
    expect(buildChannelRedirectNotice(ASKED, 'onboardingOrchestrator', REFUSAL)).not.toContain(
      '**',
    );
  });
});
