import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryConversationRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-conversation.repository';
import { CONVERSATION_TTL_MS } from '../../../src/features/conversation/domain/ports/conversation.repository';

/**
 * Ce test vit sous `tests/unit/repositories/` et non `tests/unit/infrastructure/` :
 * ce dernier est EXCLU du run unitaire par `vitest.config.ts` (rattaché à l'intégration).
 */

const T0 = new Date('2026-08-11T02:55:00.000Z');

function draft(
  overrides: Partial<{
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    agentId: string;
    slackUserId: string | null;
  }> = {},
) {
  return {
    conversationId: 'D0BJGBVB5HP',
    role: 'user' as const,
    content: 'Bonjour',
    agentId: 'onboardingOrchestrator',
    slackUserId: 'U0BMBEJTBMJ',
    ...overrides,
  };
}

describe('InMemoryConversationRepository', () => {
  let repo: InMemoryConversationRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    repo = new InMemoryConversationRepository();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('append', () => {
    it('attribue un identifiant et un horodatage', async () => {
      const saved = await repo.append(draft({ content: 'Email: karyl@kisso.com' }));

      expect(saved.id).toBeTruthy();
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.createdAt.getTime()).toBe(T0.getTime());
      expect(saved.content).toBe('Email: karyl@kisso.com');
      expect(saved.role).toBe('user');
      expect(saved.agentId).toBe('onboardingOrchestrator');
      expect(saved.slackUserId).toBe('U0BMBEJTBMJ');
    });

    it('attribue des identifiants distincts', async () => {
      const a = await repo.append(draft());
      const b = await repo.append(draft());
      expect(a.id).not.toBe(b.id);
    });

    it('accepte un tour assistant sans utilisateur Slack', async () => {
      const saved = await repo.append(
        draft({ role: 'assistant', content: 'Bien reçu.', slackUserId: null }),
      );
      expect(saved.slackUserId).toBeNull();
    });
  });

  describe('recentTurns', () => {
    it('renvoie du plus ancien au plus récent', async () => {
      await repo.append(draft({ content: 'un' }));
      vi.setSystemTime(new Date(T0.getTime() + 1_000));
      await repo.append(draft({ role: 'assistant', content: 'deux', slackUserId: null }));
      vi.setSystemTime(new Date(T0.getTime() + 2_000));
      await repo.append(draft({ content: 'trois' }));

      const turns = await repo.recentTurns('D0BJGBVB5HP', {
        ttlMs: CONVERSATION_TTL_MS,
        limit: 50,
      });

      expect(turns.map((t) => t.content)).toEqual(['un', 'deux', 'trois']);
    });

    it('isole les conversations entre elles', async () => {
      await repo.append(draft({ conversationId: 'D111', content: 'dm' }));
      await repo.append(draft({ conversationId: 'CMLKC4S5T:1.1', content: 'thread' }));

      const dm = await repo.recentTurns('D111', { ttlMs: CONVERSATION_TTL_MS, limit: 50 });
      const thread = await repo.recentTurns('CMLKC4S5T:1.1', {
        ttlMs: CONVERSATION_TTL_MS,
        limit: 50,
      });

      expect(dm.map((t) => t.content)).toEqual(['dm']);
      expect(thread.map((t) => t.content)).toEqual(['thread']);
    });

    it('renvoie une liste vide pour une conversation inconnue', async () => {
      expect(
        await repo.recentTurns('D-inconnu', { ttlMs: CONVERSATION_TTL_MS, limit: 50 }),
      ).toEqual([]);
    });

    it('ignore les tours au-delà du TTL', async () => {
      await repo.append(draft({ content: 'trop vieux' }));

      vi.setSystemTime(new Date(T0.getTime() + CONVERSATION_TTL_MS + 60_000));
      await repo.append(draft({ content: 'récent' }));

      const turns = await repo.recentTurns('D0BJGBVB5HP', {
        ttlMs: CONVERSATION_TTL_MS,
        limit: 50,
      });

      expect(turns.map((t) => t.content)).toEqual(['récent']);
    });

    it('conserve un tour juste sous le TTL', async () => {
      await repo.append(draft({ content: 'limite' }));

      vi.setSystemTime(new Date(T0.getTime() + CONVERSATION_TTL_MS - 1_000));

      const turns = await repo.recentTurns('D0BJGBVB5HP', {
        ttlMs: CONVERSATION_TTL_MS,
        limit: 50,
      });

      expect(turns.map((t) => t.content)).toEqual(['limite']);
    });

    it('respecte le `limit` en gardant les tours les PLUS RÉCENTS', async () => {
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(new Date(T0.getTime() + i * 1_000));
        await repo.append(draft({ content: `msg-${i}` }));
      }

      const turns = await repo.recentTurns('D0BJGBVB5HP', { ttlMs: CONVERSATION_TTL_MS, limit: 3 });

      expect(turns.map((t) => t.content)).toEqual(['msg-7', 'msg-8', 'msg-9']);
    });
  });

  describe('prune', () => {
    it('supprime les tours antérieurs à la date et renvoie leur nombre', async () => {
      await repo.append(draft({ content: 'vieux-1' }));
      await repo.append(draft({ content: 'vieux-2' }));

      vi.setSystemTime(new Date(T0.getTime() + CONVERSATION_TTL_MS + 60_000));
      await repo.append(draft({ content: 'récent' }));

      const removed = await repo.prune(new Date(Date.now() - CONVERSATION_TTL_MS));

      expect(removed).toBe(2);
      const turns = await repo.recentTurns('D0BJGBVB5HP', {
        ttlMs: CONVERSATION_TTL_MS,
        limit: 50,
      });
      expect(turns.map((t) => t.content)).toEqual(['récent']);
    });

    it('purge toutes les conversations, pas seulement une', async () => {
      await repo.append(draft({ conversationId: 'D111' }));
      await repo.append(draft({ conversationId: 'D222' }));

      vi.setSystemTime(new Date(T0.getTime() + CONVERSATION_TTL_MS + 60_000));

      expect(await repo.prune(new Date(Date.now() - CONVERSATION_TTL_MS))).toBe(2);
    });

    it('renvoie 0 quand rien ne dépasse la date', async () => {
      await repo.append(draft());
      expect(await repo.prune(new Date(T0.getTime() - 60_000))).toBe(0);
    });
  });

  it('expose un TTL unique de 60 minutes', () => {
    expect(CONVERSATION_TTL_MS).toBe(60 * 60 * 1000);
  });
});
