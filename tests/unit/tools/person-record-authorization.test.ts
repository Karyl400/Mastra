import { describe, it, expect, vi } from 'vitest';

import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { makeGetTaskList } from '../../../src/features/employee/application/tools/get-task-list';
import { makeGetNotificationHistory } from '../../../src/features/notification/application/tools/get-notification-history';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE CÂBLAGE, et pas seulement la décision
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `canReadPersonRecord` a ses propres tests (`tests/unit/shared/`). Ils ne prouvent RIEN sur
 * le comportement des outils — c'est la classe de défaut la plus fréquente de ce dépôt : deux
 * bords corrects, aucun câblage entre les deux. Et c'est précisément ce qui s'était produit
 * ici : la machinerie d'autorisation existait (`SlackAccessGuard`, `disclosure-policy`,
 * `canPerformSideEffects`), et ces trois outils-là ne l'appelaient simplement pas.
 *
 * Les tests ci-dessous vérifient donc la seule chose qui compte : le REPOSITORY N'EST JAMAIS
 * INTERROGÉ quand le demandeur n'a pas le droit. Un test qui se contenterait de regarder le
 * résultat laisserait passer une implémentation qui lit d'abord et filtre ensuite — laquelle
 * fuite par la latence et journalise une consultation qui n'aurait pas dû avoir lieu.
 */

const ME = 'd20df236-5c24-42a5-b205-d0d738d34fb4';
const SOMEONE_ELSE = 'd36b78dc-a039-4160-b86a-bd3d2a722b6c';

/** Demandeur réel, identifié, mais SANS le niveau `full`. */
const restrictedRequester = {
  requestContext: buildSlackRequestContext({
    channel: 'D0MOCKDM01',
    slackUserId: 'U0BJBDGTJUD',
    employeeId: ME,
    accessLevel: 'readonly',
  }),
};

const employeeRow = {
  id: SOMEONE_ELSE,
  firstName: 'Awa',
  lastName: 'B',
  email: 'awa@kissohq.com',
  department: 'Engineering',
  position: 'Developer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: 'pending',
  managerId: null,
};

describe('getEmployeeProfile — frontière d’autorisation', () => {
  it('REFUSE le dossier d’un tiers sans jamais interroger la base', async () => {
    const findById = vi.fn().mockResolvedValue(employeeRow);
    const tool = makeGetEmployeeProfile(
      { findById } as never,
      { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
      { findByEmployee: vi.fn().mockResolvedValue([]) } as never,
    );

    const result = (await tool.execute!(
      { employeeId: SOMEONE_ELSE } as never,
      restrictedRequester as never,
    )) as { found: boolean; reason: string; hint: string };

    expect(result.found).toBe(false);
    expect(result.reason).toBe('not_authorized');
    // La garantie qui compte : la donnée n'a pas été lue, donc elle n'a pas pu fuiter.
    expect(findById).not.toHaveBeenCalled();
    // Le modèle doit savoir qu'il ne s'agit pas d'un obstacle à contourner : c'est ce
    // comportement exact qui a produit 38 `findEmployeeByEmail` en 1,5 s le 2026-08-12.
    expect(result.hint).toMatch(/ne réessaie pas/i);
  });

  it('laisse passer la lecture de SON PROPRE dossier', async () => {
    const findById = vi.fn().mockResolvedValue({ ...employeeRow, id: ME });
    const tool = makeGetEmployeeProfile(
      { findById } as never,
      { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
      { findByEmployee: vi.fn().mockResolvedValue([]) } as never,
    );

    const result = (await tool.execute!(
      { employeeId: ME } as never,
      restrictedRequester as never,
    )) as { found: boolean };

    expect(result.found).toBe(true);
    expect(findById).toHaveBeenCalledWith(ME);
  });

  it('n’exige rien hors Slack — playground, workflow, test', async () => {
    // Sans ce comportement, brancher l'autorisation couperait d'un coup tous les appelants
    // qui n'ont pas de demandeur. L'absence de contexte n'est pas un refus.
    const findById = vi.fn().mockResolvedValue(employeeRow);
    const tool = makeGetEmployeeProfile(
      { findById } as never,
      { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
      { findByEmployee: vi.fn().mockResolvedValue([]) } as never,
    );

    const result = (await tool.execute!({ employeeId: SOMEONE_ELSE } as never, {} as never)) as {
      found: boolean;
    };

    expect(result.found).toBe(true);
  });
});

describe('getTaskList — frontière d’autorisation', () => {
  it('REFUSE les tâches d’un tiers sans jamais interroger la base', async () => {
    const findByEmployee = vi.fn().mockResolvedValue([]);
    const tool = makeGetTaskList({ findByEmployee } as never);

    const result = (await tool.execute!(
      { employeeId: SOMEONE_ELSE } as never,
      restrictedRequester as never,
    )) as { found: boolean; reason: string; totalTasks: number };

    expect(result.found).toBe(false);
    expect(result.reason).toBe('not_authorized');
    expect(result.totalTasks).toBe(0);
    expect(findByEmployee).not.toHaveBeenCalled();
  });

  it('laisse passer SES PROPRES tâches', async () => {
    const findByEmployee = vi.fn().mockResolvedValue([]);
    const tool = makeGetTaskList({ findByEmployee } as never);

    await tool.execute!({ employeeId: ME } as never, restrictedRequester as never);

    expect(findByEmployee).toHaveBeenCalledWith(ME);
  });
});

describe('getNotificationHistory — frontière d’autorisation', () => {
  it('REFUSE l’historique d’un tiers sans jamais interroger la base', async () => {
    // Ce que quelqu'un a reçu, et quand, est une donnée personnelle au même titre que son
    // dossier : l'historique dit qui s'occupe de lui et depuis quand.
    const findByRecipient = vi.fn().mockResolvedValue([]);
    const tool = makeGetNotificationHistory({ findByRecipient } as never);

    const result = (await tool.execute!(
      { recipientId: SOMEONE_ELSE } as never,
      restrictedRequester as never,
    )) as { reason: string; total: number };

    expect(result.reason).toBe('not_authorized');
    expect(result.total).toBe(0);
    expect(findByRecipient).not.toHaveBeenCalled();
  });

  it('laisse passer SON PROPRE historique', async () => {
    const findByRecipient = vi.fn().mockResolvedValue([]);
    const tool = makeGetNotificationHistory({ findByRecipient } as never);

    await tool.execute!({ recipientId: ME } as never, restrictedRequester as never);

    expect(findByRecipient).toHaveBeenCalledWith(ME);
  });
});
