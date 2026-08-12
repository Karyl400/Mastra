/**
 * Anti-régression du coût et de l'effet de bord d'une salutation.
 *
 * Production du 2026-08-12, 21:58 UTC — « Bonjour », sept caractères :
 *
 *   toolCalls: ["findEmployeeByEmail","getEmployeeProfile","updateOnboardingStatus","getTaskList"]
 *   steps: 5, inputTokens: 13376
 *
 * Une tentative d'écriture non demandée sur le dossier de la personne, et 13 % du budget
 * Groq quotidien, pour un mot de politesse.
 *
 * ⚠️ Le cas qui compte le plus ici n'est PAS la reconnaissance des salutations — c'est le
 * NON-déclenchement sur une vraie demande qui commence par une salutation. Court-circuiter
 * « Salut, tu peux me retrouver le profil de … ? » serait bien pire que le défaut corrigé.
 */
import { describe, it, expect } from 'vitest';
import { isBareGreeting, GREETING_REPLY } from '../../../src/shared/greeting';

describe('isBareGreeting — salutations nues', () => {
  it.each([
    'Bonjour',
    'bonjour',
    'BONJOUR',
    'Bonjour !',
    'bonjour.',
    'Salut',
    'salut !',
    'Bonsoir',
    'Coucou',
    'Hello',
    'hey',
    'Bonjour 👋',
    '  bonjour  ',
    'Bonjour à tous',
    'Bonne journée',
  ])('%j est reconnu', (text) => {
    expect(isBareGreeting(text)).toBe(true);
  });
});

describe('isBareGreeting — tout le reste passe au modèle', () => {
  it.each([
    // Les quatre formes réellement observées dans les campagnes de production.
    'Bonjour, que peux tu faire pour moi?',
    'bonjour, que peux faire pour moi?',
    'Salut, tu peux me retrouver le profil de karylsoumaila1@gmail.com ?',
    'Salut, tu peux me préparer un quiz de 3 questions sur nos valeurs ?',
    // Une salutation SUIVIE d'une demande reste une demande.
    'Bonjour ! Génère moi un guide de bienvenue en PDF',
    'Hello, where is my onboarding guide?',
    // Ni vide, ni bavardage.
    '',
    '   ',
    "Merci beaucoup pour ton aide, c'est parfait",
    'Bonjour Karyl, comment vas-tu depuis la semaine dernière ?',
  ])('%j n est PAS court-circuité', (text) => {
    expect(isBareGreeting(text)).toBe(false);
  });

  it('un message long est écarté avant toute normalisation', () => {
    expect(isBareGreeting(`bonjour ${'a'.repeat(200)}`)).toBe(false);
  });

  it('null et undefined ne lèvent pas', () => {
    expect(isBareGreeting(null)).toBe(false);
    expect(isBareGreeting(undefined)).toBe(false);
  });
});

describe('GREETING_REPLY', () => {
  it('oriente au lieu de saluer en retour', () => {
    // Quelqu'un qui écrit « bonjour » à un bot attend de savoir quoi lui demander.
    expect(GREETING_REPLY).toMatch(/profil/i);
    expect(GREETING_REPLY).toMatch(/document/i);
  });

  it('reste court — il est posté à chaque salutation, sans appel LLM', () => {
    expect(GREETING_REPLY.length).toBeLessThan(200);
  });
});
