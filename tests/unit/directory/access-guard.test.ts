import { describe, it, expect } from 'vitest';
import {
  SlackAccessGuard,
  readAuthzEnforce,
} from '../../../src/features/directory/application/services/access-guard';
import type { AccessSubject } from '../../../src/features/directory/domain/services/access-policy';

const POLICY = { orgEmailDomains: ['kissohq.com'] };

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

const guest = () => subject({ isUltraRestricted: true });

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
      policy: POLICY,
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
      policy: POLICY,
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
      policy: POLICY,
      enforce: true,
    });

    const result = await guard.evaluate('U1');
    expect(result.effective).toBe('readonly');
    expect(result.enforced).toBe(true);
  });

  it('applique le refus d’un bot', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => subject({ isBot: true }),
      policy: POLICY,
      enforce: true,
    });

    expect((await guard.evaluate('U1')).effective).toBe('denied');
  });

  it('laisse un membre de l’organisation intact', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => subject(),
      policy: POLICY,
      enforce: true,
    });

    const result = await guard.evaluate('U1');
    expect(result.effective).toBe('full');
    expect(result.decision.reason).toBe('org_member');
  });
});

describe('SlackAccessGuard — garde-fou de configuration', () => {
  it('REFUSE d’appliquer quand aucun domaine n’est déclaré', async () => {
    // Appliquer ici rétrograderait l'organisation entière sur une variable d'environnement
    // oubliée, et le symptôme (« le bot ne sait plus rien faire ») ne désignerait pas sa
    // cause. Fail-open, mais bruyant.
    const guard = new SlackAccessGuard({
      resolveSubject: async () => subject(),
      policy: { orgEmailDomains: [] },
      enforce: true,
    });

    const result = await guard.evaluate('U1');
    expect(result.decision.reason).toBe('policy_not_configured');
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
      policy: POLICY,
      enforce: true,
    });

    const result = await guard.evaluate('U1');
    expect(result.decision).toEqual({ level: 'readonly', reason: 'unknown_actor' });
    expect(result.effective).toBe('readonly');
  });

  it('rétrograde un inconnu sans le refuser', async () => {
    const guard = new SlackAccessGuard({
      resolveSubject: async () => null,
      policy: POLICY,
      enforce: true,
    });

    expect((await guard.evaluate('U1')).effective).toBe('readonly');
  });
});
