import { describe, it, expect } from 'vitest';

import { judgeWorkspace } from '../../../src/shared/slack-team';

/**
 * La règle d'appartenance au workspace, exercée là où elle décide.
 *
 * ⚠️ Elle vit dans `shared/` parce qu'elle a **deux** consommateurs — le handler d'événements
 * et la route d'interactivité — et que la recopier était exactement ce qui a manqué jusqu'au
 * 2026-08-21 : la vérification existait d'un seul côté.
 */
describe('judgeWorkspace', () => {
  it("n'écarte rien quand SLACK_TEAM_ID n'est pas posée — fail-open assumé", () => {
    const verdict = judgeWorkspace('T_AUTRE', undefined);
    expect(verdict.accepted).toBe(true);
    // `checked: false` permet à l'appelant de dire que le contrôle DORT, plutôt que de laisser
    // croire qu'il a passé. Un contrôle inactif silencieux est indiscernable d'un contrôle vert.
    expect(verdict).toMatchObject({ checked: false });
  });

  it('accepte le bon workspace', () => {
    expect(judgeWorkspace('TMLKC4EPP', 'TMLKC4EPP')).toMatchObject({
      accepted: true,
      checked: true,
    });
  });

  it('REFUSE un autre workspace, et nomme les deux valeurs', () => {
    const verdict = judgeWorkspace('T_INTRUS', 'TMLKC4EPP');
    expect(verdict.accepted).toBe(false);
    expect(verdict).toMatchObject({ received: 'T_INTRUS', expected: 'TMLKC4EPP' });
  });

  it("accepte une charge SANS team_id — le champ est absent de certaines d'entre elles", () => {
    // Le refuser transformerait une défense en profondeur en panne intermittente : le symptôme
    // serait « le bot ignore certains événements » sans qu'aucune règle ne le dise.
    expect(judgeWorkspace(undefined, 'TMLKC4EPP').accepted).toBe(true);
    expect(judgeWorkspace('', 'TMLKC4EPP').accepted).toBe(true);
  });

  it('tolère les espaces autour des deux valeurs', () => {
    expect(judgeWorkspace(' TMLKC4EPP ', ' TMLKC4EPP ').accepted).toBe(true);
  });
});
