import { describe, it, expect } from 'vitest';

import { RequestContext } from '@mastra/core/request-context';

import {
  SLACK_EXCERPT_COVERAGE_KEY,
  readExcerptCoverage,
  writeExcerptCoverage,
} from '../../../src/shared/slack-request-context';
import { describeCoverageForHuman } from '../../../src/features/knowledge/domain/services/excerpt-budget';
import type { ConversationExcerpt } from '../../../src/features/knowledge/domain/entities/conversation-excerpt';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA COUVERTURE, QUATRIÈME FORME — et cette fois elle ne dépend plus du modèle
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trois formes ont été essayées et MESURÉES EN ÉCHEC en production, toutes les trois sur le
 * même canal :
 *
 *  1. un champ de tool-result nommé `coverage` — purement ignoré ;
 *  2. le même texte renommé `hint` — ignoré aussi. **Un champ séparé se lit comme une
 *     métadonnée, quel que soit son nom** ;
 *  3. la phrase inlinée juste AVANT les extraits, dans `conversation` — le modèle l'a lue,
 *     mais ne l'a pas relayée. Le 2026-08-18 il a même conclu « Aucun obstacle concret n'est
 *     mentionné » sur 6 messages vus sur 8, c'est-à-dire exactement ce que la phrase lui
 *     interdit. Une consigne d'agent reformulée pour couvrir l'affirmation NÉGATIVE a été
 *     déployée, puis mesurée en échec le même jour, sur le même canal.
 *
 * Deux agents, deux consignes, deux échecs : la conclusion est celle que ce dépôt tire déjà
 * ailleurs — **une consigne est PROBABLE, le code est GARANTI**.
 *
 * D'où la quatrième forme : le tool ÉCRIT la phrase dans le `RequestContext`, canal serveur
 * qui ne traverse ni le prompt, ni les schémas, ni le tool-result — coût en tokens NUL — et
 * le handler l'accole à la réponse. Le modèle n'est plus sur le chemin.
 */

describe('le canal serveur porte la couverture, à coût nul', () => {
  it('l’écrit et la relit', () => {
    const ctx = new RequestContext();
    writeExcerptCoverage(ctx, '6 messages sur 8, du 2026-07-21 au 2026-08-04');

    expect(readExcerptCoverage(ctx)).toBe('6 messages sur 8, du 2026-07-21 au 2026-08-04');
  });

  it('porte le PRÉFIXE `slack`, donc le garde anti-forge la couvre d’avance', () => {
    // `createRequestContextGuard` surveille un PRÉFIXE et non une liste recopiée, précisément
    // pour que les clés pas encore écrites soient protégées. Ce test est la contrepartie :
    // il empêche d'ajouter une clé qui sortirait de cette surveillance.
    expect(SLACK_EXCERPT_COVERAGE_KEY.startsWith('slack')).toBe(true);
  });

  it('ne LÈVE jamais hors Slack — playground, workflow, test', () => {
    // `readSlackContext` a exactement ce contrat, et pour la même raison : ces chemins-là
    // n'ont pas de contexte, c'est leur cas NOMINAL.
    expect(readExcerptCoverage(undefined)).toBeUndefined();
    expect(readExcerptCoverage({})).toBeUndefined();
    expect(readExcerptCoverage(new RequestContext())).toBeUndefined();
  });

  it('ignore une valeur vide plutôt que de produire une note creuse', () => {
    const ctx = new RequestContext();
    writeExcerptCoverage(ctx, '   ');

    expect(readExcerptCoverage(ctx)).toBeUndefined();
  });
});

describe('la phrase destinée à l’HUMAIN', () => {
  const excerpts = (n: number): ConversationExcerpt[] =>
    Array.from({ length: n }, (_, i) => ({
      source: 'channel' as const,
      speaker: 'Nazer',
      text: `message ${i}`,
      at: new Date(Date.UTC(2026, 6, 21 + i)),
    }));

  it('dit le compte et la période', () => {
    const text = describeCoverageForHuman(excerpts(8), 6);

    expect(text).toContain('6');
    expect(text).toContain('8');
    expect(text).toContain('2026-07-21');
  });

  it('est ABSENTE quand tout a été montré', () => {
    // Un avertissement systématique deviendrait du bruit, et le bruit s'ignore. Même
    // arbitrage que le `hint` de `generateDocument`, payé uniquement dans les cas dégradés.
    expect(describeCoverageForHuman(excerpts(4), 4)).toBeUndefined();
    expect(describeCoverageForHuman([], 0)).toBeUndefined();
  });

  it('s’adresse à un humain, jamais au modèle', () => {
    // La forme destinée au modèle ordonne (« Ne conclus pas que… ») ; celle-ci CONSTATE.
    // Poster un impératif adressé au modèle dans Slack donnerait à lire une consigne interne.
    const text = describeCoverageForHuman(excerpts(8), 6)!;

    expect(text).not.toMatch(/ne conclus pas/i);
    expect(text).not.toContain('**');
  });
});
