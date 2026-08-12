import { describe, it, expect } from 'vitest';

import {
  authorizeChannelRead,
  authorizeMemoryRead,
  authorizeOtherMemoryRead,
  mayDiscloseBotUtterances,
  type Requester,
} from '../../../src/features/knowledge/domain/services/disclosure-policy';
import type { AccessPolicyConfig } from '../../../src/features/directory/domain/services/access-policy';

/**
 * LE TEST QUI FERME LE DEPUTY CONFUS (`PLAN-ARCHITECTURE.md` §4.1).
 *
 * Le scénario est repris tel quel du plan : le bot est membre de
 * `#engineer-karyl`, PRIVÉ ; un invité mono-canal lui écrit en DM et demande un
 * résumé de ce qui s'y dit. Sans cette politique, il l'obtient — parce que le
 * BOT y a accès.
 *
 * Chaque cas ci-dessous est une phrase de la règle, pas un chemin de code : ils
 * se lisent comme la spécification qu'ils sont.
 */

const POLICY: AccessPolicyConfig = { orgEmailDomains: ['kissohq.com'] };

const HR = 'U_HR_MEMBER';
const GUEST = 'U_SINGLE_CHANNEL_GUEST';
const OTHER = 'U_SOMEONE_ELSE';

function orgMember(slackUserId = HR): Requester {
  return {
    slackUserId,
    subject: {
      slackUserId,
      email: 'rh@kissohq.com',
      isBot: false,
      isRestricted: false,
      isUltraRestricted: false,
      isDeleted: false,
    },
  };
}

function singleChannelGuest(slackUserId = GUEST): Requester {
  return {
    slackUserId,
    subject: {
      slackUserId,
      // Un invité PORTEUR d'une adresse interne : le cas que le contrôle vise.
      email: 'invite@kissohq.com',
      isBot: false,
      isRestricted: true,
      isUltraRestricted: true,
      isDeleted: false,
    },
  };
}

describe('authorizeChannelRead — les droits du DEMANDEUR, jamais ceux du bot', () => {
  it("refuse l'invité mono-canal sur un canal privé dont le bot est membre", () => {
    // Le fait que le bot lise `#engineer-karyl` n'apparaît nulle part dans la
    // décision : la seule entrée est l'appartenance du demandeur.
    const verdict = authorizeChannelRead(singleChannelGuest(), false, POLICY);

    expect(verdict).toEqual({ allowed: false, reason: 'not_channel_member' });
  });

  it('autorise ce même invité sur un canal DONT IL EST MEMBRE', () => {
    // On miroite l'ACL Slack, on n'en invente pas une seconde : il voit déjà ce
    // canal dans son client, le lui refuser n'ajouterait aucune sécurité.
    const verdict = authorizeChannelRead(singleChannelGuest(), true, POLICY);

    expect(verdict).toEqual({ allowed: true, reason: 'ok_channel_member' });
  });

  it("refuse un membre de l'organisation NON membre du canal", () => {
    // Le privilège `full` ouvre la mémoire du bot, pas les canaux privés : ce ne
    // sont pas les mêmes données.
    const verdict = authorizeChannelRead(orgMember(), false, POLICY);

    expect(verdict).toEqual({ allowed: false, reason: 'not_channel_member' });
  });

  it('refuse quand il n’y a aucun demandeur (hors Slack)', () => {
    // Pas de demandeur ⇒ pas de droits ⇒ rien à divulguer. C'est l'inverse du
    // réflexe « dégrader » des autres tools, et c'est délibéré.
    expect(authorizeChannelRead(null, true, POLICY)).toEqual({
      allowed: false,
      reason: 'no_requester',
    });
  });

  it('refuse un bot et un compte désactivé, même membres du canal', () => {
    const bot: Requester = {
      slackUserId: 'U_BOT',
      subject: {
        slackUserId: 'U_BOT',
        email: null,
        isBot: true,
        isRestricted: false,
        isUltraRestricted: false,
        isDeleted: false,
      },
    };
    const deactivated: Requester = {
      slackUserId: 'U_OLD',
      subject: {
        slackUserId: 'U_OLD',
        email: 'parti@kissohq.com',
        isBot: false,
        isRestricted: false,
        isUltraRestricted: false,
        isDeleted: true,
      },
    };

    expect(authorizeChannelRead(bot, true, POLICY).allowed).toBe(false);
    expect(authorizeChannelRead(deactivated, true, POLICY).allowed).toBe(false);
  });
});

describe('authorizeMemoryRead — la mémoire du bot', () => {
  it('autorise toujours quelqu’un à relire ses PROPRES échanges, invité compris', () => {
    // Refuser à un invité l'accès à sa propre conversation serait un contresens
    // sur ce que cette donnée est.
    expect(authorizeMemoryRead(singleChannelGuest(), GUEST, POLICY)).toEqual({
      allowed: true,
      reason: 'ok_self',
    });
  });

  it("refuse à un invité les échanges d'un TIERS", () => {
    // §4.1 transposé de la porte « canal » à la porte « mémoire », par laquelle
    // il serait autrement passé intact.
    expect(authorizeMemoryRead(singleChannelGuest(), OTHER, POLICY)).toEqual({
      allowed: false,
      reason: 'insufficient_privilege',
    });
  });

  it("autorise un membre de l'organisation sur les échanges d'un tiers", () => {
    expect(authorizeMemoryRead(orgMember(), OTHER, POLICY)).toEqual({
      allowed: true,
      reason: 'ok_org_member',
    });
  });

  it('refuse un demandeur inconnu de l’annuaire sur un tiers, mais pas sur lui-même', () => {
    // Un inconnu garde son identité (le `requestContext` la porte) sans obtenir
    // le moindre privilège : on n'invente pas ses drapeaux d'autorisation.
    const unknown: Requester = { slackUserId: 'U_NEW', subject: null };

    expect(authorizeMemoryRead(unknown, OTHER, POLICY).allowed).toBe(false);
    expect(authorizeMemoryRead(unknown, 'U_NEW', POLICY)).toEqual({
      allowed: true,
      reason: 'ok_self',
    });
  });

  it('sans domaine déclaré, personne ne lit les échanges d’un tiers', () => {
    // Le défaut de configuration est le REFUS — à l'inverse du mode observation
    // de `SlackAccessGuard`, qui protège des flux préexistants. Ici il n'y a rien
    // à protéger : la capacité est neuve.
    const unconfigured: AccessPolicyConfig = { orgEmailDomains: [] };

    expect(authorizeMemoryRead(orgMember(), OTHER, unconfigured).allowed).toBe(false);
    expect(authorizeMemoryRead(orgMember(), HR, unconfigured).allowed).toBe(true);
  });

  it('rend le même verdict que le palier « autrui », sans connaître la cible', () => {
    // La porte sans cible existe pour être franchie AVANT toute résolution
    // d'annuaire : c'est ce qui supprime l'oracle « existe / n'existe pas ».
    // Elle doit dire exactement la même chose que le palier 3 — sinon elle
    // devient une seconde politique, et deux copies divergent.
    expect(authorizeOtherMemoryRead(orgMember(), POLICY)).toEqual(
      authorizeMemoryRead(orgMember(), OTHER, POLICY),
    );
    expect(authorizeOtherMemoryRead(singleChannelGuest(), POLICY)).toEqual(
      authorizeMemoryRead(singleChannelGuest(), OTHER, POLICY),
    );
    expect(authorizeOtherMemoryRead(null, POLICY)).toEqual({
      allowed: false,
      reason: 'no_requester',
    });
  });

  it('ne confond pas un domaine voisin avec le domaine de l’organisation', () => {
    // `notkissohq.com` s'enregistre pour quelques euros. La règle est celle de
    // `resolveAccess` — c'est précisément pour ne pas la réécrire qu'on l'importe.
    const lookalike: Requester = {
      slackUserId: OTHER,
      subject: {
        slackUserId: OTHER,
        email: 'attaquant@notkissohq.com',
        isBot: false,
        isRestricted: false,
        isUltraRestricted: false,
        isDeleted: false,
      },
    };

    expect(authorizeMemoryRead(lookalike, HR, POLICY).allowed).toBe(false);
  });
});

describe('mayDiscloseBotUtterances — la fuite transitive par la mémoire', () => {
  it("interdit les tours du BOT dès que la conversation est celle d'un tiers", () => {
    // Le bot résume des canaux PRIVÉS dont il est membre, et ce résumé est
    // persisté dans la conversation `D…` du demandeur. Servi à un membre `full`
    // étranger au canal, il ouvre ce canal par ricochet — précisément ce que
    // `authorizeChannelRead` refuse en face.
    expect(mayDiscloseBotUtterances(orgMember(), OTHER)).toBe(false);
    expect(mayDiscloseBotUtterances(singleChannelGuest(), OTHER)).toBe(false);
    expect(mayDiscloseBotUtterances(null, OTHER)).toBe(false);
  });

  it('les autorise sur ses PROPRES échanges, invité compris', () => {
    // Aucune amplification : le bot ne lui apprend rien qu'il n'ait déjà lu
    // dans Slack, c'est sa conversation.
    expect(mayDiscloseBotUtterances(orgMember(), HR)).toBe(true);
    expect(mayDiscloseBotUtterances(singleChannelGuest(), GUEST)).toBe(true);
  });

  it('ne dépend PAS du privilège : `full` n’ouvre pas la parole du bot', () => {
    // La règle est le lien à la conversation, jamais le niveau d'accès — sinon
    // elle se contournerait par un simple domaine email.
    expect(mayDiscloseBotUtterances(orgMember(), GUEST)).toBe(false);
  });
});
