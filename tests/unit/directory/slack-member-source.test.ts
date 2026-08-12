import { describe, it, expect, vi } from 'vitest';

import {
  SlackMemberSource,
  type SlackMemberReader,
} from '../../../src/features/directory/infrastructure/providers/slack-member-source.adapter';
import type { SlackMember } from '../../../src/features/notification/domain/ports/slack-workspace.port';
import type { SlackMemberPage } from '../../../src/features/notification/infrastructure/providers/slack-workspace.service';

/**
 * `SlackMemberSource` — la seule implémentation de `MemberSource`.
 *
 * Deux propriétés justifient ce fichier, et aucune n'est cosmétique :
 *
 *  1. **La pagination.** `users.list` rend 100 entrées par défaut et n'annonce sa suite que par
 *     `response_metadata.next_cursor`. Une source non paginée synchroniserait un annuaire
 *     PARTIEL — donc une politique d'autorisation qui rétrograde en `unknown_actor` toute
 *     personne ayant eu le tort d'être en page 2.
 *  2. **Aucun filtre.** Les bots, les invités et surtout les comptes DÉSACTIVÉS doivent
 *     traverser : `isDeleted` est le fait qui fait refuser un ex-salarié. `listMembers()`, elle,
 *     les écarte — et c'est pourquoi la synchronisation ne passe pas par elle.
 */

function member(overrides: Partial<SlackMember> = {}): SlackMember {
  return {
    id: 'U0AWA',
    name: 'awa',
    realName: 'Awa Diop',
    email: 'awa.diop@kissohq.com',
    firstName: 'Awa',
    lastName: 'Diop',
    displayName: 'awa',
    isBot: false,
    isAdmin: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    teamId: 'TMLKC4EPP',
    ...overrides,
  };
}

/** Doublure du lecteur Slack : des pages servies dans l'ordre, curseurs compris. */
function makeReader(pages: SlackMemberPage[], byId: SlackMember | null = null): SlackMemberReader {
  let call = 0;
  return {
    listMembersPage: vi.fn(async () => pages[call++] ?? { members: [] }),
    getUserById: vi.fn(async () => byId),
  };
}

describe('Directory: SlackMemberSource', () => {
  it('suit le curseur jusqu à la dernière page', async () => {
    const reader = makeReader([
      { members: [member({ id: 'U1' }), member({ id: 'U2' })], nextCursor: 'page2' },
      { members: [member({ id: 'U3' })], nextCursor: 'page3' },
      { members: [member({ id: 'U4' })] },
    ]);

    const source = new SlackMemberSource(reader);
    const facts = await source.fetchAll();

    expect(facts.map((f) => f.slackUserId)).toEqual(['U1', 'U2', 'U3', 'U4']);
    expect(reader.listMembersPage).toHaveBeenCalledTimes(3);
    expect(source.wasLastFetchTruncated()).toBe(false);
  });

  it('ne lit PAS que la première page (le défaut de users.list, 100 entrées)', async () => {
    const reader = makeReader([
      { members: [member({ id: 'U1' })], nextCursor: 'suite' },
      { members: [member({ id: 'U2' })] },
    ]);

    const facts = await new SlackMemberSource(reader).fetchAll();

    expect(facts).toHaveLength(2);
  });

  it('AVOUE la troncature quand le plafond de pages est atteint', async () => {
    // Un curseur qui ne se vide jamais : bug d'API, ou workspace plus grand que le plafond.
    const reader: SlackMemberReader = {
      listMembersPage: vi.fn(async () => ({ members: [member({ id: 'U1' })], nextCursor: 'x' })),
      getUserById: vi.fn(async () => null),
    };

    const source = new SlackMemberSource(reader, { maxPages: 3 });
    const facts = await source.fetchAll();

    expect(reader.listMembersPage).toHaveBeenCalledTimes(3);
    expect(facts).toHaveLength(3);
    // LE point : un tableau nu se lirait « il n'y a que 3 personnes ».
    expect(source.wasLastFetchTruncated()).toBe(true);
  });

  it('remet le drapeau de troncature à zéro entre deux balayages', async () => {
    const source = new SlackMemberSource(
      makeReader([{ members: [member({ id: 'U1' })], nextCursor: 'x' }]),
      { maxPages: 1 },
    );
    await source.fetchAll();
    expect(source.wasLastFetchTruncated()).toBe(true);

    const complete = new SlackMemberSource(makeReader([{ members: [member({ id: 'U1' })] }]));
    await complete.fetchAll();
    expect(complete.wasLastFetchTruncated()).toBe(false);
  });

  it('conserve les comptes DÉSACTIVÉS, les bots et les invités', async () => {
    const reader = makeReader([
      {
        members: [
          member({ id: 'UBOT', isBot: true, email: null }),
          member({ id: 'UOLD', isDeleted: true }),
          member({ id: 'UGUEST', isRestricted: true, isUltraRestricted: true }),
        ],
      },
    ]);

    const facts = await new SlackMemberSource(reader).fetchAll();

    // Les écarter produirait un annuaire où ne figurent que les gens à qui l'on dit oui,
    // c'est-à-dire aucune décision d'autorisation.
    expect(facts.map((f) => f.slackUserId)).toEqual(['UBOT', 'UOLD', 'UGUEST']);
    expect(facts[1]?.isDeleted).toBe(true);
    expect(facts[2]?.isUltraRestricted).toBe(true);
    expect(facts[0]?.email).toBeNull();
  });

  it('écarte un membre sans identifiant plutôt que de créer un sujet fantôme', async () => {
    const reader = makeReader([{ members: [member({ id: '' }), member({ id: 'U1' })] }]);

    const facts = await new SlackMemberSource(reader).fetchAll();

    // `slack_user_id` est la PRIMARY KEY : une chaîne vide créerait une ligne unique que toutes
    // les suivantes viendraient écraser.
    expect(facts.map((f) => f.slackUserId)).toEqual(['U1']);
  });

  it('projette tous les faits d autorisation', async () => {
    const reader = makeReader([
      {
        members: [
          member({
            id: 'U9',
            teamId: 'T9',
            email: 'x@kissohq.com',
            realName: 'Xavier',
            displayName: 'xav',
            isAdmin: true,
            isRestricted: true,
          }),
        ],
      },
    ]);

    const [facts] = await new SlackMemberSource(reader).fetchAll();

    expect(facts).toEqual({
      slackUserId: 'U9',
      teamId: 'T9',
      email: 'x@kissohq.com',
      realName: 'Xavier',
      displayName: 'xav',
      isBot: false,
      isAdmin: true,
      isRestricted: true,
      isUltraRestricted: false,
      isDeleted: false,
    });
  });

  it('fetchById rend null sur un compte introuvable, sans lever', async () => {
    const source = new SlackMemberSource(makeReader([], null));

    // Cette méthode est atteignable depuis le chemin de l'ACK Slack (3 s) : y lever pour un
    // identifiant inconnu coûterait le traitement du message entier.
    await expect(source.fetchById('U-inconnu')).resolves.toBeNull();
  });

  it('fetchById rend les faits d un compte connu', async () => {
    const source = new SlackMemberSource(makeReader([], member({ id: 'U7', isDeleted: true })));

    const facts = await source.fetchById('U7');

    expect(facts?.slackUserId).toBe('U7');
    expect(facts?.isDeleted).toBe(true);
  });
});
