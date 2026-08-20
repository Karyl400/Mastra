/**
 * LE TROISIÈME CANAL DE SORTIE — celui qui n'avait aucun filtre.
 *
 * `sanitizeAgentOutput` n'a qu'UN seul site d'appel : `response.text`, dans le handler
 * Slack. Ce dépôt l'a écrit onze fois dans ses propres commentaires, et en a tiré la
 * leçon pour le canal DOCUMENT (`sanitizeDocumentSource`, 2026-08-11). Il ne l'a jamais
 * tirée pour `sendNotification`, dont le champ `body` est de la prose LIBRE écrite par le
 * modèle — jusqu'à 5 000 caractères — et qui partait :
 *
 *   - en `html:` dans un email signé de l'adresse de l'entreprise (`smtp.adapter.ts`),
 *   - brute dans un message Slack,
 *   - et TELLE QUELLE en base, d'où `getNotificationHistory` la relit.
 *
 * Trois sorties, zéro filtre. Le pire cas n'est pas théorique : un `<a href>` vers un
 * domaine tiers, expédié depuis l'adresse de l'entreprise à un salarié, est un hameçonnage
 * que le produit fabrique lui-même.
 *
 * ⚠️ DEUX défauts distincts, et il faut les deux correctifs — l'un ne couvre pas l'autre :
 *   1. le CONTENU n'était pas assaini (marqueurs internes, liens hors liste blanche) ;
 *   2. le TEXTE BRUT atterrissait dans un slot HTML, donc était INTERPRÉTÉ.
 * Échapper le HTML ne retire pas `https://evil.tld`. Retirer le lien n'empêche pas
 * `<script>` d'être interprété.
 */
import { describe, it, expect } from 'vitest';

import {
  sanitizeNotificationBody,
  NOTIFICATION_BODY_PLACEHOLDER,
} from '../../../src/shared/security/agent-output';
import {
  htmlEmailBody,
  textEmailBody,
} from '../../../src/features/notification/domain/services/email-body';

describe('sanitizeNotificationBody — le contenu', () => {
  it('retire un lien hors liste blanche, et GARDE le reste du message', () => {
    // Contrat du DOCUMENT, pas celui de Slack : on ne remplace pas le livrable entier.
    // Une notification amputée de son lien reste utile ; une notification remplacée par
    // un refus ne dit plus rien à personne.
    const { text, strippedUrls } = sanitizeNotificationBody(
      'Ton badge est prêt. Récupère-le sur https://evil.tld/reset avant vendredi.',
    );

    expect(text).not.toContain('evil.tld');
    expect(text).toContain('Ton badge est prêt');
    expect(text).toContain('avant vendredi');
    expect(strippedUrls).toEqual(['evil.tld']);
  });

  it('laisse passer un lien Slack légitime', () => {
    const { text, strippedUrls } = sanitizeNotificationBody('Voir https://kissohq.slack.com/x');

    expect(text).toContain('https://kissohq.slack.com/x');
    expect(strippedUrls).toEqual([]);
  });

  it('retire un marqueur interne sans détruire la notification', () => {
    // ⚠️ Le délimiteur fait 32 hex depuis le 2026-08-10, et le motif exige `{16,}` — un
    // `kisso_a3f9` de quatre caractères N'EST PAS un marqueur, délibérément : le seuil a
    // été resserré le 2026-08-12 après deux faux refus mesurés en production, où le modèle
    // narrait `guide_kisso_2026.pdf` et voyait TOUTE sa réponse remplacée.
    const { text, redacted } = sanitizeNotificationBody(
      'Rappel : kisso_a3f9c2e1b8d47ف60a5e3f1c9b7d2a4e6 réunion à 14h.'.replace('ف', ''),
    );

    expect(text).not.toContain('kisso_a3f9c2e1');
    expect(text).toContain('réunion à 14h');
    expect(redacted).toContain('delimiter');
  });

  it('laisse passer un `kisso_` court — le seuil de 16 hex est un correctif, pas un trou', () => {
    // Non-régression du 2026-08-12. Ce test existe pour qu'un futur durcissement du motif
    // rougisse ici plutôt qu'en production, sur un tour détruit qui vaut 5 % du quota du jour.
    expect(sanitizeNotificationBody('Ton guide_kisso_2026.pdf est prêt.').redacted).toEqual([]);
  });

  it("rend un texte de remplacement plutôt qu'un corps VIDE", () => {
    // Un corps vide part quand même : l'email est expédié, illisible, et le destinataire
    // ne peut ni comprendre ni réagir. Même famille que `emailSent: false` sous
    // `status: 'success'` — l'envoi réussit, le message ne dit rien.
    expect(sanitizeNotificationBody('   ').text).toBe(NOTIFICATION_BODY_PLACEHOLDER);
  });
});

describe('EmailBody — le slot', () => {
  it('ÉCHAPPE le texte brut : une balise ne peut pas être interprétée', () => {
    const body = textEmailBody('<a href="https://evil.tld">Réinitialise ton mot de passe</a>');

    expect(body.html).not.toContain('<a href');
    expect(body.html).toContain('&lt;a href');
  });

  it('préserve les sauts de ligne du texte brut', () => {
    // Sans cela, un message rédigé en paragraphes arrive en un seul bloc : le défaut
    // est cosmétique mais il touche CHAQUE notification, et il vient du même bug.
    expect(textEmailBody('Bonjour,\n\nÀ demain.').html).toContain('<br');
  });

  it('laisse INTACT un gabarit HTML délibéré', () => {
    // `welcome-email.ts` produit du vrai HTML et échappe déjà ses valeurs avec `esc()`.
    // Échapper une seconde fois afficherait `<p>` littéralement dans le premier message
    // que l'entreprise envoie à un arrivant.
    const body = htmlEmailBody('<p>Bonjour <strong>Karyl</strong>,</p>');

    expect(body.html).toBe('<p>Bonjour <strong>Karyl</strong>,</p>');
  });

  it('dérive un repli texte sans balise dans les deux cas', () => {
    expect(htmlEmailBody('<p>Bonjour <strong>Karyl</strong></p>').text).toBe('Bonjour Karyl');
    expect(textEmailBody('a < b et c > d').text).toBe('a < b et c > d');
  });
});
