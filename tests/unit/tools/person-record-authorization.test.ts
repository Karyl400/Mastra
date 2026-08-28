import { describe, it, expect, vi } from 'vitest';

import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { makeGetNotificationHistory } from '../../../src/features/notification/application/tools/get-notification-history';
import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
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
    );

    const result = (await tool.execute!(
      { employeeId: ME } as never,
      restrictedRequester as never,
    )) as { found: boolean };

    expect(result.found).toBe(true);
    expect(findById).toHaveBeenCalledWith(ME);
  });

  it('REFUSE hors Slack — ce test disait l’inverse jusqu’au 2026-08-28', async () => {
    // ⚠️ CE TEST VERROUILLAIT LE DÉFAUT. Il s'appelait « n'exige rien hors Slack — playground,
    // workflow, test » et affirmait : « L'absence de contexte n'est pas un refus ». Son
    // commentaire nommait explicitement « route HTTP » : l'auteur avait CONSIDÉRÉ ce chemin et
    // l'avait jugé nominal. C'est la troisième occurrence dans ce dépôt de la famille qu'il
    // documente lui-même — « `status = Sent` était posé avant le `try`, et un test verrouillait
    // ce mensonge ».
    //
    // Ce qui a changé n'est pas l'avis, c'est un FAIT : depuis le 2026-08-14,
    // `createRequestContextGuard` refuse (400) toute clé `slack*` venue d'un appelant HTTP.
    // « Pas de contexte » a donc cessé d'être la marque du playground pour devenir l'état
    // GARANTI de tout appel `/api/*` — porteur d'un `MASTRA_API_TOKEN`, mais anonyme. La
    // prémisse du test d'origine était vraie le jour où il a été écrit ; elle ne l'est plus.
    //
    // ⚠️ `mayTouchRecord` n'a PAS bougé, et c'est délibéré : le playground et les workflows en
    // dépendent réellement. Le second verrou est ici, au bord de l'outil — là où l'on sait que
    // ce qu'on va lire est un dossier RH.
    const findById = vi.fn().mockResolvedValue(employeeRow);
    const tool = makeGetEmployeeProfile(
      { findById } as never,
      { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
    );

    const result = (await tool.execute!({ employeeId: SOMEONE_ELSE } as never, {} as never)) as {
      found: boolean;
      reason: string;
    };

    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_requester');
    expect(findById).not.toHaveBeenCalled();
  });
});

/**
 * ⚠️ LE CONTOURNEMENT LE PLUS LARGE, relevé par la revue adversariale APRÈS que les trois
 * lectures RH eurent été fermées.
 *
 * `generateDocument` restituait le même dossier par un chemin voisin, et en pire : il imprime
 * `firstName`, `lastName`, `email`, `department`, `position` et `startDate` de la personne
 * dans le document, puis livre le fichier dans le canal du DEMANDEUR. Soit, en deux messages,
 * un PDF téléchargeable et repartageable portant le dossier d'un collègue.
 */
describe('generateDocument — frontière d’autorisation', () => {
  const documentTool = (findById: ReturnType<typeof vi.fn>) =>
    makeGenerateDocument({
      documentRepo: { save: vi.fn(), findById: vi.fn() },
      employeeRepo: { findById },
      renderers: [{ format: 'pdf', render: vi.fn() }],
    } as never);

  it('REFUSE de produire un document au nom d’un tiers, sans lire la fiche', async () => {
    const findById = vi.fn().mockResolvedValue(employeeRow);

    const result = (await documentTool(findById).execute!(
      {
        employeeId: SOMEONE_ELSE,
        type: 'welcome_letter',
        title: 'Bienvenue',
        content: 'Bonjour et bienvenue.',
      } as never,
      restrictedRequester as never,
    )) as { saved: boolean; reason: string; delivery: string };

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('not_authorized');
    expect(result.delivery).toBe('none');
    // La garantie qui compte : la fiche n'a pas été lue, donc rien n'a pu être imprimé.
    expect(findById).not.toHaveBeenCalled();
  });

  it('laisse passer un document produit pour SOI-MÊME', async () => {
    const findById = vi.fn().mockResolvedValue({ ...employeeRow, id: ME });

    await documentTool(findById).execute!(
      {
        employeeId: ME,
        type: 'welcome_letter',
        title: 'Bienvenue',
        content: 'Bonjour et bienvenue.',
      } as never,
      restrictedRequester as never,
    );

    expect(findById).toHaveBeenCalledWith(ME);
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

// ════════════════════════════════════════════════════════════════════════════
// LA FRONTIÈRE S'OUVRAIT PAR L'ABSENCE — audit du 2026-08-28, § 1.1
// ════════════════════════════════════════════════════════════════════════════
//
// `mayTouchRecord` commence par `if (!context) return true`, AVANT tout contrôle de niveau.
// `AUTHZ_ENFORCE` est sans effet sur ce chemin. Or depuis le 2026-08-14,
// `createRequestContextGuard` REFUSE (400) toute clé `slack*` fournie par un appelant HTTP :
// **tout appel `/api/*` a donc nécessairement un contexte vide.** Un bon correctif a creusé le
// trou. Mesuré en production sur `POST /api/agents/onboardingOrchestrator/generate` avec une
// adresse fictive : `getEmployeeProfile` s'est EXÉCUTÉ, sans aucun refus.
//
// ⚠️ Le correctif ne touche PAS `mayTouchRecord` : `readSlackContext` rend `undefined` sur le
// playground, les workflows et tous les tests, où c'est le cas NOMINAL. Le refermer là couperait
// le produit de lui-même. Le second verrou appartient **au bord de l'outil** — la forme existe
// déjà dans ce dépôt, appliquée à quatre outils (`get-channel-history`, `get-user-conversations`,
// `search-knowledge`, `schedule-candidate-interview`).
//
// ⚠️ Et il tombe AVANT `findByEmail`. Le chemin par email doit lire pour résoudre ; s'il lisait
// avant de refuser, un appelant non authentifié énumérerait l'annuaire une adresse à la fois.

const noRequester = { requestContext: undefined };

describe('une lecture de dossier RH exige un DEMANDEUR', () => {
  it('getEmployeeProfile refuse sans contexte, sans interroger la base (par identifiant)', async () => {
    const findById = vi.fn().mockResolvedValue(employeeRow);
    const tool = makeGetEmployeeProfile(
      { findById } as never,
      { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
    );

    const result = (await tool.execute!(
      { employeeId: SOMEONE_ELSE } as never,
      noRequester as never,
    )) as { found: boolean; reason: string };

    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_requester');
    expect(findById).not.toHaveBeenCalled();
  });

  it('… et par EMAIL, sans jamais résoudre l’adresse — sinon c’est un oracle', async () => {
    const findByEmail = vi.fn().mockResolvedValue(employeeRow);
    const tool = makeGetEmployeeProfile(
      { findByEmail } as never,
      { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
    );

    const result = (await tool.execute!(
      { email: 'awa@kissohq.com' } as never,
      noRequester as never,
    )) as { found: boolean; reason: string };

    expect(result.reason).toBe('no_requester');
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('getNotificationHistory refuse sans contexte, sans interroger la base', async () => {
    const findByRecipient = vi.fn().mockResolvedValue([]);
    const tool = makeGetNotificationHistory({ findByRecipient } as never);

    const result = (await tool.execute!(
      { recipientId: SOMEONE_ELSE } as never,
      noRequester as never,
    )) as { found: boolean; reason: string };

    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_requester');
    expect(findByRecipient).not.toHaveBeenCalled();
  });

  it('CONTRÔLE — un demandeur identifié garde son PROPRE dossier', async () => {
    const findById = vi.fn().mockResolvedValue({ ...employeeRow, id: ME });
    const tool = makeGetEmployeeProfile(
      { findById } as never,
      { findByEmployee: vi.fn().mockResolvedValue(null) } as never,
    );

    const result = (await tool.execute!(
      { employeeId: ME } as never,
      restrictedRequester as never,
    )) as { found: boolean };

    expect(result.found).toBe(true);
    expect(findById).toHaveBeenCalled();
  });
});
