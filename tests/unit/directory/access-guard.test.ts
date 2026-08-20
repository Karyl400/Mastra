import { describe, it, expect } from 'vitest';
import {
  SlackAccessGuard,
  readAuthzEnforce,
} from '../../../src/features/directory/application/services/access-guard';
import type { AccessSubject } from '../../../src/features/directory/domain/services/access-policy';

/** Il y a un manager quelque part : le cas nominal, celui où l'application est permise. */
const MANAGER_EXISTS = async () => true;

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

const guest = () => subject({ isUltraRestricted: true });
const manager = () => subject({ isManager: true });

describe('readAuthzEnforce', () => {
  it('n’applique que sur une valeur explicitement affirmative', () => {
    expect(readAuthzEnforce('true')).toBe(true);
    expect(readAuthzEnforce('1')).toBe(true);
    expect(readAuthzEnforce(' YES ')).toBe(true);
  });

  it('reste en observation sur tout le reste', () => {
    expect(readAuthzEnforce(undefined)).toBe(false);
    expect(readAuthzEnforce('')).toBe(false);
    expect(readAuthzEnforce('false')).toBe(false);
    expect(readAuthzEnforce('oui')).toBe(false);
  });
});

describe('SlackAccessGuard — mode observation', () => {
  it('calcule la décision restrictive MAIS ne l’applique pas', () => {
    // La propriété centrale : `decision` et `effective` divergent. Si le mode observation
    // court-circuitait le calcul, les journaux relus avant activation décriraient un code
    // différent de celui qu'on activerait — on n'aurait rien mesuré.
    const guard = new SlackAccessGuard({
      resolveSubject: async () => guest(),
      enforce: false,
    });

    return guard.evaluate('U1').then((result) => {
      expect(result.decision).toEqual({ level: 'readonly', reason: 'guest' });
      expect(result.effective).toBe('full');
      expect(result.enforced).toBe(false);
    });
  });

  it('laisse passer même un bot, tout en le nommant dans la décision', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => subject({ isBot: true }),
      enforce: false,
    });

    const result = await guard.evaluate('U1');
    expect(result.decision.level).toBe('denied');
    expect(result.effective).toBe('full');
  });
});

describe('SlackAccessGuard — mode appliqué', () => {
  it('applique la rétrogradation d’un invité', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => guest(),
      enforce: true,
      hasManager: MANAGER_EXISTS,
    });

    const result = await guard.evaluate('U1');
    expect(result.effective).toBe('readonly');
    expect(result.enforced).toBe(true);
  });

  it('applique le refus d’un bot', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => subject({ isBot: true }),
      enforce: true,
      hasManager: MANAGER_EXISTS,
    });

    expect((await guard.evaluate('U1')).effective).toBe('denied');
  });

  it('laisse le MANAGER intact', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => manager(),
      enforce: true,
      hasManager: MANAGER_EXISTS,
    });

    const result = await guard.evaluate('U1');
    expect(result.effective).toBe('full');
    expect(result.decision.reason).toBe('manager');
  });

  it('rétrograde un employé qui n’est PAS manager', async () => {
    // C'est le cas nominal du produit depuis le 2026-08-20 : `readonly` est ce que reçoit
    // tout le monde sauf une personne. Il ne coupe personne de son propre dossier — cette
    // garantie-là vit dans `canReadPersonRecord` et `canPerformSideEffects`.
    const guard = new SlackAccessGuard({
      resolveSubject: async () => subject(),
      enforce: true,
      hasManager: MANAGER_EXISTS,
    });

    const result = await guard.evaluate('U1');
    expect(result.effective).toBe('readonly');
    expect(result.decision.reason).toBe('not_a_manager');
  });
});

describe('SlackAccessGuard — garde-fou de configuration', () => {
  it('REFUSE d’appliquer tant qu’AUCUN manager n’est désigné', async () => {
    // Appliquer ici rétrograderait l'organisation entière sur une désignation oubliée, et le
    // symptôme (« le bot ne sait plus rien faire ») ne désignerait pas sa cause. Fail-open,
    // mais bruyant. ⚠️ Plus probable qu'avant : la colonne `role` naît VIDE, donc « aucun
    // manager » est l'état de DÉPART, pas un accident.
    const guard = new SlackAccessGuard({
      resolveSubject: async () => manager(),
      enforce: true,
      hasManager: async () => false,
    });

    const result = await guard.evaluate('U1');
    expect(result.enforced).toBe(false);
    expect(result.effective).toBe('full');
  });

  it('REFUSE d’appliquer quand aucun moyen de vérifier n’a été câblé', async () => {
    // Sans ce contrôle on ne peut pas distinguer « configuré » de « personne n'a été
    // désigné ». Un oubli de câblage ne doit pas se traduire par une application aveugle.
    const guard = new SlackAccessGuard({
      resolveSubject: async () => guest(),
      enforce: true,
    });

    expect((await guard.evaluate('U1')).enforced).toBe(false);
  });

  it('APPLIQUE dès qu’un manager existe', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => guest(),
      enforce: true,
      hasManager: MANAGER_EXISTS,
    });

    expect((await guard.evaluate('U1')).enforced).toBe(true);
  });

  it('ne re-vérifie PAS une fois le manager constaté — une lecture, pas une par message', async () => {
    let calls = 0;
    const guard = new SlackAccessGuard({
      resolveSubject: async () => guest(),
      enforce: true,
      hasManager: async () => {
        calls += 1;
        return true;
      },
    });

    await guard.evaluate('U1');
    await guard.evaluate('U2');
    await guard.evaluate('U3');

    expect(calls).toBe(1);
  });

  it('n’applique pas quand le contrôle LÈVE — une panne n’est pas une preuve d’absence', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => guest(),
      enforce: true,
      hasManager: async () => {
        throw new Error('no such column: role');
      },
    });

    const result = await guard.evaluate('U1');
    expect(result.enforced).toBe(false);
    expect(result.effective).toBe('full');
  });
});

describe('SlackAccessGuard — robustesse', () => {
  it('ne lève jamais quand l’annuaire échoue, et rétrograde', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => {
        throw new Error('no such table: slack_directory');
      },
      enforce: true,
      hasManager: MANAGER_EXISTS,
    });

    const result = await guard.evaluate('U1');
    expect(result.decision).toEqual({ level: 'readonly', reason: 'unknown_actor' });
    expect(result.effective).toBe('readonly');
  });

  it('rétrograde un inconnu sans le refuser', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => null,
      enforce: true,
      hasManager: MANAGER_EXISTS,
    });

    expect((await guard.evaluate('U1')).effective).toBe('readonly');
  });
});
