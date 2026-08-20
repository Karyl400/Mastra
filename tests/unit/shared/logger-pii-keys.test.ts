import { describe, it, expect } from 'vitest';
import { maskPii, isPiiKey, PII_KEYS } from '../../../src/shared/logger';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `PII_KEYS` — la liste de prose humaine, et l'exclusion de `message`
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le 2026-08-14, `maskPii` a été étendu aux champs de PROSE écrite par un humain
 * (`text`, `content`, `body`, `fact`, `dailyWork`, `workStyle`). `subject` avait été
 * OUBLIÉ — alors que `send-notification.ts` le journalise en `info`, et que c'est de la
 * prose écrite par le MODÈLE à propos d'une personne nommée, sur le même appel qui porte
 * déjà `recipientId`.
 *
 * ⚠️ `message` est délibérément EXCLU et doit le rester : c'est le champ des messages
 * d'erreur dans tout le dépôt (`{ error: message }`, `maskSpecialType` sur `Error`). Le
 * masquer supprimerait le diagnostic au lieu de protéger quelqu'un. Cette exclusion n'était
 * verrouillée par AUCUN test — seulement par une phrase de `CLAUDE.md`, c'est-à-dire par
 * rien.
 */
describe('PII_KEYS', () => {
  describe('prose écrite par un humain ou par le modèle', () => {
    const PROSE_KEYS = [
      'text',
      'content',
      'body',
      'fact',
      'dailyWork',
      'workStyle',
      'subject',
    ] as const;

    it.each(PROSE_KEYS)('masque `%s`', (key) => {
      expect(isPiiKey(key)).toBe(true);
      const masked = maskPii({ [key]: 'Bienvenue Awa TRAORE chez Kisso' }) as Record<
        string,
        unknown
      >;
      expect(masked[key]).toBe('[REDACTED:SENSITIVE]');
    });

    it('masque `subject` là où le tool le journalise réellement — à côté de recipientId', () => {
      const masked = maskPii({
        recipientId: 'b1f2…',
        recipientType: 'employee',
        channel: 'email',
        subject: 'Ton premier jour chez Kisso, Awa',
      }) as Record<string, unknown>;

      expect(masked.subject).toBe('[REDACTED:SENSITIVE]');
      expect(masked.channel).toBe('email');
    });
  });

  describe('`message` — exclusion délibérée', () => {
    it("n'est PAS traité comme du PII", () => {
      expect(PII_KEYS.has('message')).toBe(false);
      expect(isPiiKey('message')).toBe(false);
    });

    it("laisse lisible un message d'erreur journalisé sous la clé `message`", () => {
      const masked = maskPii({ message: 'no such column: content' }) as Record<string, unknown>;
      expect(masked.message).toBe('no such column: content');
    });

    it("laisse lisible le `message` d'une Error journalisée", () => {
      const masked = maskPii(new Error('missing_scope: files:write')) as Record<string, unknown>;
      expect(masked.message).toBe('missing_scope: files:write');
    });
  });
});
