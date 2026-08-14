import { describe, it, expect } from 'vitest';

import { buildWelcomeEmail } from '../../../src/features/onboarding/domain/services/welcome-email';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « que les emails se rapprochent le plus possible de la réalité de
 *   l'utilisateur et ne soient pas simplement génériques »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Deux défauts distincts, et le premier est le plus grave.
 *
 * L'ancien texte PROMETTAIT « les accès à nos outils ainsi que votre planning de première
 * semaine ». Il n'existe ni provisioning ni planning dans ce système. C'était le tout premier
 * message de l'entreprise à un arrivant, et il ouvrait sur une promesse que rien ne tient.
 *
 * Et il était générique alors que `position` et `startDate` étaient SAISIS dans la modale,
 * puis jetés au passage d'un schéma d'étape, deux étapes avant l'email.
 */

const BASE = { firstName: 'Awa', lastName: 'TRAORE' };

describe('buildWelcomeEmail — ne promet que ce qui existe', () => {
  it('ne promet NI accès aux outils NI planning', () => {
    // Garde-fou de non-retour : ces deux phrases reviendraient à la première relecture qui
    // les trouverait « accueillantes » — c'est ce qui les avait fait écrire.
    const mail = buildWelcomeEmail({ ...BASE, position: 'Backend Developer' });

    expect(mail.body).not.toMatch(/accès à nos outils/i);
    expect(mail.body).not.toMatch(/planning/i);
    expect(mail.body).not.toMatch(/première semaine/i);
  });

  it('la seule projection dans le futur est VRAIE — le DM avec le bouton part réellement', () => {
    const mail = buildWelcomeEmail(BASE);
    expect(mail.body).toMatch(/compléter ton profil/i);
  });
});

describe('buildWelcomeEmail — la réalité de la personne', () => {
  it('cite le poste, l’équipe et le premier jour EN TOUTES LETTRES', () => {
    const mail = buildWelcomeEmail({
      ...BASE,
      position: 'Backend Developer',
      department: 'Engineering',
      startDate: '2026-09-01T00:00:00.000Z',
    });

    expect(mail.subject).toBe('Bienvenue chez Kisso Industries, Awa !');
    expect(mail.body).toContain('Backend Developer');
    expect(mail.body).toContain('Engineering');
    // « 2026-09-01T00:00:00.000Z » ne dit rien à un arrivant ; « mardi 1 septembre 2026 » si.
    expect(mail.body).toContain('septembre 2026');
    expect(mail.body).not.toContain('2026-09-01T');
  });

  it('cite les canaux Slack où la personne sera réellement invitée', () => {
    const mail = buildWelcomeEmail({ ...BASE, channels: ['kisso-hq', 'engineering-chat'] });
    expect(mail.body).toContain('#kisso-hq');
    expect(mail.body).toContain('#engineering-chat');
  });

  it('OMET la phrase entière quand le champ manque — jamais de « N/A »', () => {
    // Même discipline que `buildWelcomeLetter`, dont « Département : N/A » a été retiré : un
    // intertitre suivi du vide se lit comme un oubli, pas comme une absence de réponse.
    const mail = buildWelcomeEmail(BASE);

    expect(mail.body).not.toMatch(/N\/A|non renseigné|undefined|null/i);
    expect(mail.body).not.toContain('Poste :');
    expect(mail.body).not.toContain('Premier jour :');
    // Sans aucun fait, le bloc entier disparaît — y compris son intertitre.
    expect(mail.body).not.toContain('Ce que nous avons enregistré');
  });

  it('OMET le premier jour si la date est illisible, au lieu de l’imprimer brute', () => {
    const mail = buildWelcomeEmail({ ...BASE, startDate: 'lundi prochain' });
    expect(mail.body).not.toContain('Premier jour');
    expect(mail.body).not.toContain('lundi prochain');
  });

  it('ÉCHAPPE le HTML — le poste vient d’une saisie humaine dans une modale', () => {
    const mail = buildWelcomeEmail({ ...BASE, position: '<img src=x onerror=alert(1)>' });

    expect(mail.body).not.toContain('<img');
    expect(mail.body).toContain('&lt;img');
  });

  it('invite à CORRIGER quand des faits sont affichés', () => {
    // Ces données ont été saisies par quelqu'un d'autre que l'intéressé : la seule personne
    // capable de repérer une erreur est celle qui reçoit l'email.
    const mail = buildWelcomeEmail({ ...BASE, position: 'Backend Developer' });
    expect(mail.body).toMatch(/inexact/i);
  });
});
