import { describe, it, expect } from 'vitest';

import { frenchDayLabel } from '../../../src/shared/french-datetime';
import { buildContextPreamble } from '../../../src/features/notification/domain/services/context-preamble';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « Lundi prochain » n'était pas mal transcrit — il était INCALCULABLE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Sonde signée en production, 2026-08-19 : « Prépare un entretien pour … lundi prochain à 9h ».
 * Réponse : « samedi 22 août 2026 à 08:00 (UTC+01:00) ». Mauvais jour, mauvaise heure.
 *
 * La cause n'est pas une faiblesse du modèle : RIEN, dans toute la fenêtre qu'on lui donne, ne
 * disait quel jour on est — ni les `instructions`, ni le préambule, ni l'historique. Le modèle
 * a fait la seule chose possible : deviner. Même famille que `findEmployeeByEmail`
 * inatteignable ou `findPersonByName` absent — une demande qu'aucun câblage ne pouvait
 * satisfaire, à laquelle il répond en inventant.
 */

const HUMAN = 'U0BJBDGTJUD';
/** Mercredi. Le jour de la semaine est le fond du correctif : sans lui, rien ne se calcule. */
const NOW = new Date('2026-08-19T12:00:00.000Z');

describe('frenchDayLabel', () => {
  it('nomme le JOUR DE LA SEMAINE, pas seulement la date', () => {
    expect(frenchDayLabel(NOW, 'Africa/Lagos')).toBe('mercredi 19 août 2026');
  });

  it('respecte le fuseau — une date bascule le soir', () => {
    // 23:30 UTC le 19, soit 00:30 le 20 à Lagos (UTC+1). Se tromper ici décalerait tout
    // calcul de date relative d'un jour, chaque soir.
    const tard = new Date('2026-08-19T23:30:00.000Z');
    expect(frenchDayLabel(tard, 'Africa/Lagos')).toBe('jeudi 20 août 2026');
    expect(frenchDayLabel(tard, 'UTC')).toBe('mercredi 19 août 2026');
  });

  it('ne LÈVE jamais sur un fuseau mal orthographié', () => {
    // `RECRUITMENT_TIMEZONE` est une variable d'environnement : une faute de frappe ne doit
    // pas rendre le bot muet. Une date moins juste reste une date ; une exception à la
    // construction du préambule couperait toute réponse.
    expect(() => frenchDayLabel(NOW, 'Pas/UnFuseau')).not.toThrow();
    expect(frenchDayLabel(NOW, 'Pas/UnFuseau').length).toBeGreaterThan(0);
  });
});

describe('le préambule porte la date', () => {
  it('dit quel jour on est, avec le jour de la semaine', () => {
    const preamble = buildContextPreamble({ slackUserId: HUMAN, now: NOW });

    expect(preamble).toContain('mercredi 19 août 2026');
    expect(preamble).toMatch(/^Nous sommes le /);
  });

  it('ne dit RIEN quand l’horloge n’est pas fournie', () => {
    // Le playground, un workflow et un appel direct n'ont pas d'horloge injectée : mieux vaut
    // pas de date qu'une date fabriquée dans le domaine.
    const preamble = buildContextPreamble({ slackUserId: HUMAN });

    expect(preamble).not.toContain('Nous sommes le');
  });

  it('porte le FAIT seul, sans consigne', () => {
    // ⚠️ « Calcule toute date relative à partir de là, n'en invente jamais une » a été écrit
    // puis RETIRÉ : ce qui manquait n'était pas une instruction — `AGENT_ANTI_INVENTION_BLOCK`
    // interdit déjà d'inventer — mais la DONNÉE. La consigne coûtait 20 tokens par tour pour
    // répéter une règle déjà posée, sur un budget de ≈ 19 messages par jour.
    const ligne = buildContextPreamble({ slackUserId: HUMAN, now: NOW }).split('\n')[0]!;

    expect(ligne).not.toMatch(/calcule|invente/i);
    expect(Math.round(ligne.length / 3.5)).toBeLessThanOrEqual(20);
  });
});
