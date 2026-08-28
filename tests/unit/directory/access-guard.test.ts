import { describe, it, expect, vi } from 'vitest';
import {
  SlackAccessGuard,
  readAuthzEnforce,
} from '../../../src/features/directory/application/services/access-guard';
import type { AccessSubject } from '../../../src/features/directory/domain/services/access-policy';
import { logger } from '../../../src/shared/logger';

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

  it('APPLIQUE quand le contrôle LÈVE — ce test disait l’inverse jusqu’au 2026-08-28', async () => {
    // ⚠️ CE TEST VERROUILLAIT UN FAIL-OPEN. Son titre — « une panne n'est pas une preuve
    // d'absence » — était JUSTE, et sa conclusion était la mauvaise moitié de ce constat : ne
    // pas appliquer n'est pas neutre, c'est accorder `full` à tout le monde. Une panne n'est
    // pas davantage une preuve de PRÉSENCE d'un droit.
    //
    // ⚠️ Sa préoccupation, elle, reste entière et il faut la nommer : le message d'origine
    // était `no such column: role`, c'est-à-dire une migration non appliquée — une panne
    // STRUCTURELLE, que rien ne répare tout seul. Appliquer dans ce cas rétrograde
    // l'organisation entière, et le symptôme (« le bot ne sait plus rien faire ») ne désigne
    // pas sa cause. C'est exactement le raisonnement qui avait fait écrire ce test.
    //
    // Ce qui a changé, c'est que ce symptôme DÉSIGNE désormais sa cause : le diagnostic dit
    // « the directory is unreachable […] This is NOT a configuration problem », et il est
    // réémis à chaque tentative. L'argument qui soutenait le fail-open portait sur un silence
    // qui n'existe plus.
    //
    // Reste l'asymétrie des coûts, et elle tranche. Appliquer à tort retire à chacun l'accès au
    // dossier d'AUTRUI — chacun garde le sien et le droit d'agir dessus, et la base est de
    // toute façon en panne. Ne pas appliquer à tort ouvre le dossier RH de tout le monde à tout
    // le monde, pendant que tout a l'air normal. Mesuré en production le 2026-08-28 (§ 1.7).
    const guard = new SlackAccessGuard({
      resolveSubject: async () => guest(),
      enforce: true,
      hasManager: async () => {
        throw new Error('no such column: role');
      },
    });

    const result = await guard.evaluate('U1');
    expect(result.enforced).toBe(true);
    expect(result.effective).not.toBe('full');
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

// ════════════════════════════════════════════════════════════════════════════
// UNE PANNE DE BASE ACCORDAIT `full` À TOUT LE MONDE — audit du 2026-08-28, § 1.7
// ════════════════════════════════════════════════════════════════════════════
//
// `hasManager()` lit `slack_directory`, donc Turso. Son échec était rattrapé par un
// `.catch(() => false)`, donc `canEnforce()` rendait `false`, donc `effective` valait `'full'`
// POUR CHAQUE ACTEUR — alors qu'`AUTHZ_ENFORCE=true` est posé en production.
//
// ⚠️ La faute de conception est de confondre deux états que le `.catch` rendait identiques :
//   — « AUCUN manager n'est désigné » : une CONFIGURATION. La colonne naît vide, c'est l'état de
//     DÉPART. Appliquer rétrograderait l'organisation entière, donc on s'abstient — fail-open,
//     et c'est juste.
//   — « je n'ai PAS PU le savoir » : une PANNE. Elle ne dit rien de la configuration, donc elle
//     ne doit rien changer à la posture que l'exploitant a demandée.
//
// ⚠️ Le coût des deux erreurs n'est pas le même. Appliquer à tort retire à chacun l'accès au
// dossier d'AUTRUI — chacun garde le sien et le droit d'agir dessus. Ne pas appliquer à tort
// ouvre le dossier RH de tout le monde à tout le monde. Face à une panne, on garde la posture.

describe('une panne de base ne doit pas ouvrir la frontière', () => {
  const subject = { slackUserId: 'U0AUTRE', employeeId: null, role: null, isBot: false };

  function guardWith(hasManager: () => Promise<boolean>) {
    return new SlackAccessGuard({
      resolveSubject: async () => subject as never,
      enforce: true,
      hasManager,
    });
  }

  it('une lecture IMPOSSIBLE n’accorde pas `full` — la posture demandée est conservée', async () => {
    const guard = guardWith(async () => {
      throw new Error('UND_ERR_CONNECT_TIMEOUT');
    });

    const verdict = await guard.evaluate('U0AUTRE');

    expect(verdict.enforced).toBe(true);
    expect(verdict.effective).not.toBe('full');
  });

  it('CONTRÔLE — « aucun manager désigné » reste un fail-open, c’est une CONFIGURATION', async () => {
    const guard = guardWith(async () => false);

    const verdict = await guard.evaluate('U0AUTRE');

    expect(verdict.enforced).toBe(false);
    expect(verdict.effective).toBe('full');
  });

  it('CONTRÔLE — un manager désigné fait appliquer la frontière', async () => {
    const guard = guardWith(async () => true);

    const verdict = await guard.evaluate('U0AUTRE');

    expect(verdict.enforced).toBe(true);
    expect(verdict.effective).not.toBe('full');
  });

  it('la fenêtre de 60 s ne s’arme PAS sur un échec — on retente', async () => {
    // La garde posait `lastManagerCheck` AVANT l'appel : après un échec, tous les appels de la
    // minute suivante rendaient `false` sans même retenter. Une panne d'une seconde ouvrait donc
    // la frontière pour une minute pleine.
    let appels = 0;
    const guard = guardWith(async () => {
      appels += 1;
      if (appels === 1) throw new Error('base injoignable');
      return true;
    });

    await guard.evaluate('U0AUTRE');
    await guard.evaluate('U0AUTRE');

    expect(appels).toBe(2);
  });

  it('le diagnostic NOMME la panne, il n’accuse pas la configuration', async () => {
    // ⚠️ Le message affirmait « NO employee carries the manager role — designate one with
    // `npm run role:set` » alors que la cause était une base indisponible. Un message d'erreur
    // qui affirme une cause qu'il n'a pas constatée envoie chercher au mauvais endroit.
    const messages: string[] = [];
    const spy = vi.spyOn(logger, 'error').mockImplementation((m: string | Error) => {
      messages.push(String(m));
    });

    await guardWith(async () => {
      throw new Error('base injoignable');
    }).evaluate('U0AUTRE');

    spy.mockRestore();
    expect(messages.join(' ')).not.toMatch(/role:set/);
  });
});
