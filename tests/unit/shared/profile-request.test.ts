import { describe, it, expect } from 'vitest';

import { requestsProfileForm } from '../../../src/shared/profile-request';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut : le formulaire de profil était INATTEIGNABLE pour tout le monde
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `buildWelcomeBlocks` est le seul émetteur du bouton « Compléter mon profil », et son
 * seul appelant est `handleTeamJoin`. Un salarié déjà présent n'avait donc AUCUN chemin
 * vers ce formulaire — et l'événement `team_join` n'est même pas dans les abonnements de
 * l'app Slack.
 *
 * Conséquence mesurée sur la Turso de production le 2026-08-14 : `employees` contient
 * 2 lignes pour un workspace où `slack_directory` compte 4 personnes vivantes de plus,
 * toutes avec `employee_id` à `null`. C'est la cause racine du guide générique (rien à
 * personnaliser) et, indirectement, du document parti à la mauvaise adresse.
 *
 * ⚠️ L'asymétrie est INVERSE de celle de `forget.ts`, et c'est ce qui autorise un critère
 * plus large ici : un faux positif POSTE UN BOUTON — geste réversible, que la personne
 * ignore d'un clic ailleurs. Un faux négatif laisse quelqu'un sans dossier.
 */

describe('requestsProfileForm — ce qui DOIT déclencher', () => {
  const declenchent = [
    // Impératif : le verbe ouvre le message.
    'complète mon profil',
    'Complete mon profil',
    'remplis ma fiche',
    'mets à jour mon profil',
    // Intention déclarée.
    'je veux compléter mon profil',
    'je voudrais mettre à jour mes informations',
    "j'aimerais corriger ma fiche",
    'je dois compléter mon profil',
    // Demande explicite.
    'peux-tu me renvoyer le formulaire de profil ?',
    'merci de me redonner le formulaire de profil',
    // Question de MOYEN — le bouton est littéralement la réponse.
    'comment je complète mon profil ?',
    'où est-ce que je remplis mon profil ?',
  ];

  it.each(declenchent)('« %s »', (message) => {
    expect(requestsProfileForm(message)).toBe(true);
  });
});

describe('requestsProfileForm — ce qui NE DOIT PAS déclencher', () => {
  const ignorent = [
    // Négation : la personne demande le contraire.
    'je ne veux pas compléter mon profil',
    "je n'ai pas envie de remplir ma fiche",
    // Question de MOTIF : elle appelle une explication, pas un formulaire.
    'pourquoi dois-je compléter mon profil ?',
    'pourquoi mon profil est-il incomplet ?',
    // Le profil d'un TIERS : ce n'est pas le même geste, et le bouton n'y mène pas.
    'complète le profil de Awa',
    'peux-tu mettre à jour le profil de Pamela ?',
    // Le verbe sans l'objet.
    'complète cette phrase',
    'remplis le questionnaire',
    // L'objet sans le verbe : une simple consultation.
    'montre-moi mon profil',
    'quel est mon profil ?',
    // Hors sujet complet.
    'bonjour',
    '',
    '   ',
  ];

  it.each(ignorent)('« %s »', (message) => {
    expect(requestsProfileForm(message)).toBe(false);
  });

  it('ignore un texte trop long pour être une demande directe', () => {
    // Un paragraphe contient forcément autre chose, et cet autre chose mérite une vraie
    // réponse — pas un bouton déclenché par une sous-chaîne noyée dedans.
    const pave = `Bonjour, ${'je te raconte ma semaine en détail. '.repeat(12)} je veux compléter mon profil`;

    expect(pave.length).toBeGreaterThan(200);
    expect(requestsProfileForm(pave)).toBe(false);
  });

  it('ne lève pas sur une entrée absente', () => {
    expect(requestsProfileForm(undefined)).toBe(false);
    expect(requestsProfileForm(null)).toBe(false);
  });
});
