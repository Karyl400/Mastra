import { describe, it, expect } from 'vitest';
import {
  resolveAccess,
  type AccessSubject,
} from '../../../src/features/directory/domain/services/access-policy';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA FRONTIÈRE PORTE SUR LE RÔLE DEPUIS LE 2026-08-20 — pas sur le domaine email
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ce qui a changé, et pourquoi ces tests ont été RÉÉCRITS plutôt qu'étendus : `full` valait
 * « membre de l'organisation », c'est-à-dire la même portée pour les six personnes du
 * workspace — chacune pouvait lire le dossier RH des cinq autres. Il vaut désormais
 * « manager », et il n'y a plus de test de domaine à conserver : le domaine n'accorde plus
 * rien.
 *
 * La propriété qui compte n'est pas un niveau mais une INÉGALITÉ : `full` ne s'obtient que par
 * un fait qu'on ne peut pas écrire sur soi-même.
 */

function subject(overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    slackUserId: 'U123',
    email: 'pamela@kissohq.com',
    isBot: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    isManager: false,
    ...overrides,
  };
}

describe('resolveAccess — la frontière d’autorisation (P1)', () => {
  describe('le manager, et lui seul', () => {
    it('accorde `full` au porteur du rôle', () => {
      expect(resolveAccess(subject({ isManager: true }))).toEqual({
        level: 'full',
        reason: 'manager',
      });
    });

    it('accorde `full` au manager MÊME sur une adresse d’un domaine étranger', () => {
      // Ce cas n'est pas théorique : l'administratrice de l'onboarding porte une adresse
      // `gmail.com` dans l'annuaire, et l'ancienne règle la rétrogradait — la frontière
      // refusait celle qui en avait le plus besoin.
      const decision = resolveAccess(subject({ isManager: true, email: 'karyl@gmail.com' }));
      expect(decision.level).toBe('full');
    });

    it('accorde `full` au manager MÊME sans adresse du tout', () => {
      // Le domaine n'entre plus dans la décision : il ne peut donc plus, même par accident,
      // retirer quelque chose au seul rôle qui accorde.
      expect(resolveAccess(subject({ isManager: true, email: null })).level).toBe('full');
    });
  });

  describe('tous les autres — leur propre dossier, et rien de plus', () => {
    it('rétrograde un employé qui n’est pas manager, quel que soit son domaine', () => {
      expect(resolveAccess(subject({ email: 'pamela@kissohq.com' }))).toEqual({
        level: 'readonly',
        reason: 'not_a_manager',
      });
    });

    it('accorde `full` à un manager SANS aucun dossier employé', () => {
      // La donnée réelle l'impose : le General Manager de cette entreprise n'a pas de ligne
      // dans `employees`. Exiger un dossier aurait rendu la frontière indésignable sans en
      // fabriquer un — donc sans inventer une date d'embauche pour quelqu'un que ce produit
      // n'a jamais intégré. Ce test est le garde-fou de cette décision.
      expect(resolveAccess(subject({ isManager: true })).level).toBe('full');
    });
  });

  describe('rétrogradations', () => {
    it('rétrograde un invité multi-canal en lecture seule', () => {
      // Le scénario du « deputy confus » : le bot est membre d’un canal PRIVÉ, et un invité
      // qui lui parle hériterait sinon de l’union des droits du bot.
      expect(resolveAccess(subject({ isRestricted: true }))).toEqual({
        level: 'readonly',
        reason: 'guest',
      });
    });

    it('rétrograde un invité mono-canal en lecture seule', () => {
      expect(resolveAccess(subject({ isUltraRestricted: true }))).toEqual({
        level: 'readonly',
        reason: 'guest',
      });
    });

    it('rétrograde un invité MÊME s’il porte le rôle manager', () => {
      // L’ordre des règles est le fond du correctif : le statut d’invité — un fait que Slack
      // maintient — doit l’emporter sur le rôle, qui est un fait interne. L’inverse
      // accorderait `full` à un invité externe dont le dossier aurait été marqué, c’est-à-dire
      // au seul cas que ce contrôle vise.
      const decision = resolveAccess(subject({ isUltraRestricted: true, isManager: true }));
      expect(decision).toEqual({ level: 'readonly', reason: 'guest' });
    });
  });

  describe('refus', () => {
    it('refuse un bot', () => {
      expect(resolveAccess(subject({ isBot: true }))).toEqual({
        level: 'denied',
        reason: 'bot_actor',
      });
    });

    it('refuse un compte désactivé', () => {
      expect(resolveAccess(subject({ isDeleted: true }))).toEqual({
        level: 'denied',
        reason: 'deactivated_account',
      });
    });

    it('refuse un bot AVANT toute autre considération, rôle compris', () => {
      const decision = resolveAccess(subject({ isBot: true, isManager: true, isDeleted: true }));
      expect(decision.level).toBe('denied');
    });

    it('refuse un compte désactivé MÊME s’il est manager', () => {
      // Un ex-salarié dont le dossier porte encore le rôle ne doit rien conserver : c'est
      // `is_deleted`, rafraîchi par la péremption de l'annuaire, qui le lui retire.
      expect(resolveAccess(subject({ isDeleted: true, isManager: true })).level).toBe('denied');
    });
  });

  describe('sujet inconnu de l’annuaire', () => {
    it('rétrograde en lecture seule plutôt que de refuser', () => {
      // Un événement qui parvient jusqu’ici a DÉJÀ franchi la signature HMAC et le contrôle
      // de `team_id` : son origine n’est pas en doute, seul son PRIVILÈGE l’est. Refuser
      // transformerait une panne passagère de `users.info` en indisponibilité totale du bot,
      // alors que rétrograder est la réponse monotone restrictive.
      expect(resolveAccess(null)).toEqual({ level: 'readonly', reason: 'unknown_actor' });
    });
  });

  describe('propriétés d’ensemble', () => {
    it('ne rend `full` QUE sur `isManager`, jamais sur un autre fait', () => {
      const risky: AccessSubject[] = [
        subject({ isBot: true }),
        subject({ isRestricted: true }),
        subject({ isUltraRestricted: true }),
        subject({ isDeleted: true }),
        subject({ email: null }),
        subject({ email: 'eve@evil.com' }),
        subject({ email: 'pamela@kissohq.com' }),
      ];

      for (const s of risky) {
        expect(resolveAccess(s).level).not.toBe('full');
      }
    });

    it('est TOTALE : toute entrée reçoit un niveau et un motif', () => {
      const inputs: (AccessSubject | null)[] = [
        null,
        subject(),
        subject({ isManager: true }),
        subject({ isBot: true }),
        subject({ isDeleted: true }),
        subject({ isRestricted: true }),
      ];

      for (const s of inputs) {
        const decision = resolveAccess(s);
        expect(['denied', 'readonly', 'full']).toContain(decision.level);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
