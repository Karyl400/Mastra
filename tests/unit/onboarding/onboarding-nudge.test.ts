import { describe, it, expect } from 'vitest';

import { onboardingNudge } from '../../../src/features/onboarding/domain/services/onboarding-nudge';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « IL COMPLÈTE SON PROFIL PUIS CHANGE DE SUJET » — le ramener, subtilement
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Une question d'accueil attend ; la personne demande autre chose. Le message ne ressemble pas
 * à une réponse, il part chez un agent, qui répond — **et le fil d'accueil est abandonné sans
 * un mot**. Ce n'est pas un défaut de mémoire mais de STRUCTURE : l'état de la machine EST le
 * dernier tour `assistant`, et répondre vient de le remplacer. Sans rappel accolé, l'accueil
 * ne peut pas reprendre, et personne ne sait pourquoi le dossier n'a jamais été terminé.
 */

describe('onboardingNudge — nommer ce qui manque, pas « ton profil »', () => {
  it('nomme le champ attendu du dossier', () => {
    // La personne sait alors exactement ce qu'il reste à faire, et la reprise coûte une phrase
    // au lieu d'un aller-retour.
    const nudge = onboardingNudge({ kind: 'profile', step: 'lastName' }, '1700000000.000100');

    expect(nudge).toContain('ton nom de famille');
  });

  it('nomme aussi les questions de l’entretien', () => {
    const nudge = onboardingNudge({ kind: 'interview', step: 'dailyWork' }, '1700000000.000100');

    expect(nudge).toContain('ce que tu fais au quotidien');
  });

  it('reste DISCRET : une phrase, en italique, sans question ni injonction', () => {
    const nudge = onboardingNudge({ kind: 'profile', step: 'email' }, '1700000000.000100')!;

    expect(nudge.startsWith('_(')).toBe(true);
    expect(nudge.endsWith(')_')).toBe(true);
    expect(nudge).not.toContain('?');
    expect(nudge.split('\n')).toHaveLength(1);
  });

  it('rend `undefined` quand rien n’attend — jamais une chaîne vide', () => {
    // Un `''` accolé laisserait deux sauts de ligne en fin de message, trace visible d'un
    // mécanisme qui ne s'est pas déclenché.
    expect(onboardingNudge(undefined, '1700000000.000100')).toBeUndefined();
  });

  it('VARIE d’un message à l’autre, et de façon REJOUABLE', () => {
    // La répétition littérale est ce qui fait « machine », et un rappel est par nature le
    // texte qu'une personne verra le plus souvent. Jamais `Math.random()` : un test ne peut
    // pas verrouiller une réponse aléatoire, et un diagnostic ne peut pas la rejouer.
    const step = { kind: 'profile', step: 'email' } as const;
    const rendus = new Set(
      ['1700000000.000100', '1700000000.000200', '1700000000.000300', '1700000000.000400'].map(
        (ts) => onboardingNudge(step, ts),
      ),
    );

    expect(rendus.size).toBeGreaterThan(1);
    expect(onboardingNudge(step, '1700000000.000100')).toBe(
      onboardingNudge(step, '1700000000.000100'),
    );
  });
});
