import { describe, it, expect } from 'vitest';
import {
  resolveAccess,
  type AccessSubject,
  type AccessPolicyConfig,
} from '../../../src/features/directory/domain/services/access-policy';

const POLICY: AccessPolicyConfig = { orgEmailDomains: ['kissohq.com'] };

function subject(overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    slackUserId: 'U123',
    email: 'pamela@kissohq.com',
    isBot: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    ...overrides,
  };
}

describe('resolveAccess — la frontière d’autorisation (P1)', () => {
  describe('membre de l’organisation', () => {
    it('accorde `full` sur un domaine de l’organisation', () => {
      expect(resolveAccess(subject(), POLICY)).toEqual({ level: 'full', reason: 'org_member' });
    });

    it('compare le domaine sans tenir compte de la casse ni des espaces', () => {
      const decision = resolveAccess(subject({ email: '  Pamela@KissoHQ.Com ' }), POLICY);
      expect(decision.level).toBe('full');
    });

    it('n’accepte PAS un domaine dont un domaine de l’organisation n’est qu’un suffixe', () => {
      // `notkissohq.com` se termine par `kissohq.com` : une comparaison par `endsWith`
      // nue accorderait `full` à un domaine étranger enregistré par un attaquant.
      const decision = resolveAccess(subject({ email: 'eve@notkissohq.com' }), POLICY);
      expect(decision).toEqual({ level: 'readonly', reason: 'foreign_domain' });
    });

    it('accepte en revanche un vrai sous-domaine de l’organisation', () => {
      const decision = resolveAccess(subject({ email: 'ops@mail.kissohq.com' }), POLICY);
      expect(decision.level).toBe('full');
    });
  });

  describe('rétrogradations', () => {
    it('rétrograde un invité multi-canal en lecture seule', () => {
      // Le scénario du « deputy confus » : le bot est membre d’un canal PRIVÉ, et un invité
      // qui lui parle hériterait sinon de l’union des droits du bot.
      const decision = resolveAccess(subject({ isRestricted: true }), POLICY);
      expect(decision).toEqual({ level: 'readonly', reason: 'guest' });
    });

    it('rétrograde un invité mono-canal en lecture seule', () => {
      const decision = resolveAccess(subject({ isUltraRestricted: true }), POLICY);
      expect(decision).toEqual({ level: 'readonly', reason: 'guest' });
    });

    it('rétrograde un invité MÊME s’il porte une adresse de l’organisation', () => {
      // L’ordre des règles est le fond du correctif : le statut d’invité doit l’emporter sur
      // le domaine, sinon un invité que l’on aurait créé sur l’annuaire interne obtiendrait
      // `full` — et le contrôle ne servirait précisément à rien dans le seul cas qu’il vise.
      const decision = resolveAccess(
        subject({ isUltraRestricted: true, email: 'stagiaire@kissohq.com' }),
        POLICY,
      );
      expect(decision).toEqual({ level: 'readonly', reason: 'guest' });
    });

    it('rétrograde un compte sans email', () => {
      expect(resolveAccess(subject({ email: null }), POLICY)).toEqual({
        level: 'readonly',
        reason: 'no_email',
      });
    });

    it('rétrograde un domaine étranger', () => {
      expect(resolveAccess(subject({ email: 'eve@gmail.com' }), POLICY)).toEqual({
        level: 'readonly',
        reason: 'foreign_domain',
      });
    });
  });

  describe('refus', () => {
    it('refuse un bot', () => {
      expect(resolveAccess(subject({ isBot: true }), POLICY)).toEqual({
        level: 'denied',
        reason: 'bot_actor',
      });
    });

    it('refuse un compte désactivé', () => {
      expect(resolveAccess(subject({ isDeleted: true }), POLICY)).toEqual({
        level: 'denied',
        reason: 'deactivated_account',
      });
    });

    it('refuse un bot AVANT toute autre considération', () => {
      const decision = resolveAccess(
        subject({ isBot: true, email: 'bot@kissohq.com', isDeleted: true }),
        POLICY,
      );
      expect(decision.level).toBe('denied');
    });
  });

  describe('sujet inconnu de l’annuaire', () => {
    it('rétrograde en lecture seule plutôt que de refuser', () => {
      // Un événement qui parvient jusqu’ici a DÉJÀ franchi la signature HMAC et le contrôle
      // de `team_id` : son origine n’est pas en doute, seul son PRIVILÈGE l’est. Refuser
      // transformerait une panne passagère de `users.info` en indisponibilité totale du bot,
      // alors que rétrograder est la réponse monotone restrictive.
      expect(resolveAccess(null, POLICY)).toEqual({ level: 'readonly', reason: 'unknown_actor' });
    });
  });

  describe('politique non configurée', () => {
    it('n’accorde `full` à personne quand aucun domaine n’est déclaré', () => {
      // Une liste de domaines vide ne veut pas dire « tout le monde est de la maison ».
      // C’est l’appelant qui décide de faire respecter ou non la décision (mode observation) ;
      // la politique, elle, ne fabrique jamais un privilège à partir d’une absence.
      const decision = resolveAccess(subject(), { orgEmailDomains: [] });
      expect(decision).toEqual({ level: 'readonly', reason: 'policy_not_configured' });
    });
  });

  describe('propriétés d’ensemble', () => {
    it('ne rend jamais `full` à un sujet non vérifié', () => {
      const risky: AccessSubject[] = [
        subject({ isBot: true }),
        subject({ isRestricted: true }),
        subject({ isUltraRestricted: true }),
        subject({ isDeleted: true }),
        subject({ email: null }),
        subject({ email: 'eve@evil.com' }),
        subject({ email: 'eve@notkissohq.com' }),
      ];

      for (const s of risky) {
        expect(resolveAccess(s, POLICY).level).not.toBe('full');
      }
    });
  });
});
