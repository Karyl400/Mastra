import { describe, it, expect, vi, beforeEach } from 'vitest';

import { logger } from '../../../src/shared/logger';
import { makeDirectoryDouble, makeSlackHandler } from '../../helpers/slack-handler';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « Annuaire relié au dossier » était affirmé sans avoir été constaté
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Trouvé EN PRODUCTION le 2026-08-19, en testant le correctif du matin même.
 *
 * `linkRequesterToRecord` appelle `linkEmployee`, qui est un `UPDATE ... WHERE slack_user_id
 * = ?`. Quand la ligne d'annuaire N'EXISTE PAS, l'ordre s'exécute sans erreur et n'affecte
 * AUCUNE ligne — et le correctif journalisait quand même « Annuaire relié au dossier ».
 *
 * ⚠️ C'est très exactement la famille de défaut que ce correctif venait fermer : affirmer un
 * état qu'on n'a pas constaté. Relevé en production : `slack_directory` compte 41 lignes dont
 * UNE SEULE porte un `employee_id`, et l'utilisateur de la sonde n'y avait aucune ligne.
 *
 * La correction suit le patron que ce dépôt s'est déjà donné pour `forget(scope)`, dont le
 * commentaire dit : « Le compte n'est pas un confort de journalisation : c'est lui qui permet
 * à la réponse de dire ce qui s'est passé plutôt que de l'affirmer. Sans lui, le bot ne
 * pourrait que réciter "c'est fait". »
 */

const HUMAN = 'U0PROBE0001';

function makeHandler(linked: number) {
  const linkEmployee = vi.fn(async () => linked);

  // La fabrique partagée neutralise les HUIT dépendances (voir son en-tête). Seul l'annuaire
  // est spécialisé : c'est le COMPTE qu'il rend qui est l'objet même de ce fichier.
  const { handler } = makeSlackHandler({
    directoryRepository: { ...makeDirectoryDouble(), linkEmployee },
  });

  const probe = handler as unknown as {
    linkRequesterToRecord(
      slackUserId: string | undefined,
      employeeId: string | undefined,
    ): Promise<void>;
  };
  return { probe, linkEmployee };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('la liaison annuaire → dossier ne s’annonce que si elle a EU LIEU', () => {
  it('journalise une ERREUR quand aucune ligne n’a été touchée', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { probe } = makeHandler(0);

    await probe.linkRequesterToRecord(HUMAN, 'emp-1');

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('NON relié'),
      expect.objectContaining({ reason: 'no_directory_row' }),
    );
    expect(info).not.toHaveBeenCalledWith(
      expect.stringContaining('relié au dossier'),
      expect.anything(),
    );
    spy.mockRestore();
    info.mockRestore();
  });

  it('journalise le succès quand une ligne a réellement été reliée', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { probe, linkEmployee } = makeHandler(1);

    await probe.linkRequesterToRecord(HUMAN, 'emp-1');

    expect(linkEmployee).toHaveBeenCalledWith(HUMAN, 'emp-1');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('relié au dossier'),
      expect.objectContaining({ employeeId: 'emp-1' }),
    );
    info.mockRestore();
  });
});
