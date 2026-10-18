import { describe, it, expect } from 'vitest';

import {
  PROGRESS_MARKER_VARIANTS,
  progressMarkerText,
} from '../../../src/features/notification/domain/services/progress-marker';
import { AGENT_TOOLS } from '../../../src/shared/agent-capabilities';

/**
 * 2026-10-18 — « à chaque requête il répond "Je regarde ça, un instant…", et c'est parfois
 * incohérent, redondant, pas assez humain ».
 *
 * Le marqueur était UNE constante, postée avant même que l'on sache à quoi la demande servait :
 * « Je regarde ça » sur « génère-moi un PDF » ne regarde rien. Le routage est du code pur —
 * l'agent est connu avant l'appel du modèle, à coût ZÉRO — donc le texte peut en dépendre.
 */
describe('le marqueur de progression dit ce qui se passe, et ne se répète pas', () => {
  const agents = Object.keys(AGENT_TOOLS);

  it('chaque agent câblé a ses variantes — un agent ajouté sans texte fait rougir', () => {
    for (const agentId of agents) {
      expect(PROGRESS_MARKER_VARIANTS[agentId], agentId).toBeDefined();
      expect(PROGRESS_MARKER_VARIANTS[agentId]!.length, agentId).toBeGreaterThanOrEqual(3);
    }
  });

  it('le choix est DÉTERMINISTE pour un message donné', () => {
    expect(progressMarkerText('knowledgeAgent', '1700000000.000100')).toBe(
      progressMarkerText('knowledgeAgent', '1700000000.000100'),
    );
  });

  it('varie d’un message à l’autre — ce n’est plus la même phrase à chaque fois', () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => progressMarkerText('knowledgeAgent', `17000000${i}.1`)),
    );
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('le texte dépend de l’agent : la recherche ne dit pas « je prépare »', () => {
    const knowledge = new Set(PROGRESS_MARKER_VARIANTS.knowledgeAgent);
    const notification = new Set(PROGRESS_MARKER_VARIANTS.notificationAgent);
    const shared = [...knowledge].filter((text) => notification.has(text));
    expect(shared).toEqual([]);
    for (const text of knowledge) expect(text).not.toMatch(/pr[ée]pare/i);
  });

  it('un agent inconnu retombe sur un texte neutre, jamais sur une exception', () => {
    expect(PROGRESS_MARKER_VARIANTS.default).toContain(progressMarkerText('agentInconnu', 'x'));
    expect(progressMarkerText(undefined, undefined)).toBeTruthy();
  });

  it('chaque variante est courte, sans exclamation, et ne se désigne ni outil ni agent', () => {
    for (const [agentId, variants] of Object.entries(PROGRESS_MARKER_VARIANTS)) {
      for (const text of variants) {
        expect(text.length, `${agentId}: ${text}`).toBeLessThanOrEqual(60);
        expect(text, `${agentId}: ${text}`).not.toMatch(/!/);
        expect(text, `${agentId}: ${text}`).not.toMatch(/\b(outil|agent|IA|bot|assistant)\b/i);
        expect(text.endsWith('…'), `${agentId}: ${text}`).toBe(true);
      }
    }
  });

  it('aucune variante n’affirme un résultat : le marqueur est remplacé, jamais démenti', () => {
    for (const variants of Object.values(PROGRESS_MARKER_VARIANTS)) {
      for (const text of variants) {
        expect(text).not.toMatch(/\b(envoy|termin|fini|prêt|pret|c['’]est fait)/i);
      }
    }
  });
});
