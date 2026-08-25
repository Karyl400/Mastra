import { describe, it, expect } from 'vitest';

import {
  METRIC_CATALOGUE,
  METRIC_FAMILIES,
  derivableMetrics,
  missingMetrics,
} from '../../../src/features/dashboard/domain/services/metric-catalogue';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UN TABLEAU DE BORD QUI AFFICHE 0 LÀ OÙ IL N'A PAS DE SOURCE EST UN MENSONGE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * C'est la même famille de défaut que `emailSent: false` sous `status: 'success'`, que
 * `documents.content` perdu en silence, et que les cinq tâches d'onboarding qu'aucun mécanisme
 * ne faisait avancer : un chiffre qui a l'air d'une mesure et qui n'en est pas une.
 *
 * Sur un tableau de bord, le symptôme est pire qu'ailleurs, parce que la lecture est PASSIVE.
 * Personne ne va vérifier « satisfaction : 0 % » — on en conclut que les gens sont mécontents,
 * pas qu'aucune question ne leur a jamais été posée.
 *
 * D'où la règle, verrouillée ici : chaque métrique déclare sa SOURCE. Soit elle est dérivée de
 * tables nommées, soit elle est absente — et alors elle dit POURQUOI et CE QU'IL FAUDRAIT.
 */
describe('catalogue de métriques — chaque entrée déclare sa source', () => {
  it('couvre les six familles demandées, et rien de plus', () => {
    const covered = new Set(METRIC_CATALOGUE.map((m) => m.family));
    expect([...covered].sort()).toEqual([...METRIC_FAMILIES].sort());
  });

  it('aucune métrique n’est muette sur sa source', () => {
    for (const metric of METRIC_CATALOGUE) {
      if (metric.source.derived) {
        // Une métrique dérivée NOMME les tables dont elle sort. Sans cela, « dérivée » est
        // une affirmation que rien ne recalcule — la forme exacte que traque
        // `claimed-invariants.test.ts`.
        expect(metric.source.from.length).toBeGreaterThan(0);
      } else {
        expect(metric.source.because.length).toBeGreaterThan(20);
        expect(metric.source.wouldTake.length).toBeGreaterThan(20);
      }
    }
  });

  it('les clés sont uniques — deux métriques homonymes en écraseraient une', () => {
    const keys = METRIC_CATALOGUE.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('la partition dérivable / absente est exhaustive et disjointe', () => {
    expect(derivableMetrics().length + missingMetrics().length).toBe(METRIC_CATALOGUE.length);
    const overlap = derivableMetrics().filter((d) => missingMetrics().some((m) => m.key === d.key));
    expect(overlap).toEqual([]);
  });

  /**
   * ⚠️ Ces trois-là sont les demandes explicites du cahier des charges qui n'ont AUCUNE source
   * dans ce produit. Les inscrire comme dérivables serait le défaut que ce fichier existe pour
   * empêcher — et l'inverse compte aussi : si un mécanisme de feedback est un jour livré, ce
   * test rougit et force la mise à jour du catalogue. Un manque nommé doit pouvoir cesser
   * d'être un manque.
   *
   * ⚠️ **ET IL A CESSÉ D'EN ÊTRE UN, DÈS LE LENDEMAIN.** `ai.latency` figurait dans cette liste
   * le 2026-08-25 au matin ; l'écriture d'`AGENT_RUN` l'en a sortie l'après-midi, et c'est CE
   * TEST qui a rougi pour l'exiger. C'est exactement le service qu'on lui demandait : sans lui,
   * une lacune corrigée serait restée affichée comme une lacune — la dérive de
   * `READ_ONLY_TOOL_NAMES` gardant `getTaskList`, en sens inverse.
   */
  it('nomme comme ABSENTES les demandes que rien ne peut servir aujourd’hui', () => {
    const absent = missingMetrics().map((m) => m.key);
    expect(absent).toContain('satisfaction.score');
    expect(absent).toContain('satisfaction.sentiment');
    expect(absent).toContain('health.uptime');
  });

  it('ce que `AGENT_RUN` a rendu mesurable N’EST PLUS déclaré absent', () => {
    const absent = missingMetrics().map((m) => m.key);
    for (const key of ['ai.latency', 'ai.unsupportedClaims', 'ai.toolCalls']) {
      expect(absent, `${key} devrait être dérivé depuis le 2026-08-25`).not.toContain(key);
    }
  });

  it('une métrique absente ne porte jamais de valeur par défaut', () => {
    for (const metric of missingMetrics()) {
      expect(metric).not.toHaveProperty('fallbackValue');
      expect(metric).not.toHaveProperty('value');
    }
  });
});
