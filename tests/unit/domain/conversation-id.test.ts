import { describe, it, expect } from 'vitest';
import { deriveConversationId } from '../../../src/features/conversation/domain/value-objects/conversation-id';

/**
 * Règle de dérivation (décision D1 de la spec) :
 *   conversationId = threadTs ? `${channel}:${threadTs}` : channel
 *
 * L'appelant Slack calcule `threadTs` ainsi :
 *   - en DM        : `undefined` PAR CONCEPTION (threader un DM a déjà rendu le bot muet) ;
 *   - en canal     : `thread_ts ?? ts` — un thread est une conversation, un message racine ouvre la sienne.
 */
describe('deriveConversationId', () => {
  it('en DM (aucun threadTs) : la conversation EST le canal', () => {
    expect(deriveConversationId({ channel: 'D0BJGBVB5HP' })).toBe('D0BJGBVB5HP');
    expect(deriveConversationId({ channel: 'D0BJGBVB5HP', threadTs: undefined })).toBe(
      'D0BJGBVB5HP',
    );
    expect(deriveConversationId({ channel: 'D0BJGBVB5HP', threadTs: null })).toBe('D0BJGBVB5HP');
  });

  it('en canal, dans un thread : `channel:thread_ts`', () => {
    expect(deriveConversationId({ channel: 'CMLKC4S5T', threadTs: '1770000000.111111' })).toBe(
      'CMLKC4S5T:1770000000.111111',
    );
  });

  it("en canal, hors thread : `channel:ts` (l'appelant passe `thread_ts ?? ts`)", () => {
    expect(deriveConversationId({ channel: 'CMLKC4S5T', threadTs: '1770000042.222222' })).toBe(
      'CMLKC4S5T:1770000042.222222',
    );
  });

  it('deux threads du même canal sont deux conversations distinctes', () => {
    const a = deriveConversationId({ channel: 'CMLKC4S5T', threadTs: '1.1' });
    const b = deriveConversationId({ channel: 'CMLKC4S5T', threadTs: '2.2' });
    expect(a).not.toBe(b);
  });

  it('traite une chaîne vide comme une absence de thread', () => {
    expect(deriveConversationId({ channel: 'CMLKC4S5T', threadTs: '' })).toBe('CMLKC4S5T');
  });

  it('refuse un canal vide — sinon toutes les conversations fusionneraient sous la même clé', () => {
    expect(() => deriveConversationId({ channel: '' })).toThrow();
    expect(() => deriveConversationId({ channel: '   ' })).toThrow();
  });
});
