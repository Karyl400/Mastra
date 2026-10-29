import { logger } from '../../../../shared/logger';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../domain/ports/person-directory.port';
import {
  authorizeMemoryRead,
  authorizeOtherMemoryRead,
  type DisclosureReason,
  type Requester,
} from '../../domain/services/disclosure-policy';

const SLACK_USER_ID_RE = /^U[A-Z0-9]{4,}$/i;

export type SearchVerdict =
  | DisclosureReason
  | 'person_not_resolved'
  | 'person_not_found'
  | 'nothing_known'
  | 'no_readable_channel'
  | 'knowledge_unavailable';

const VERDICT_HINTS: Partial<Record<SearchVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  insufficient_privilege:
    "Seul le manager peut chercher ce qu'une AUTRE personne a dit. Dis-le, et propose de chercher sans nommer personne.",
  requester_denied: 'Compte non autorisé.',
  person_not_resolved: 'Donne un email ou un identifiant Slack (U…), pas un prénom.',
  person_not_found: "Personne inconnue de l'annuaire.",
  nothing_known:
    'Rien en base sur ce sujet. Si un canal précis est en jeu, `getChannelHistory` peut le lire en direct — sinon dis simplement que tu ne sais pas.',
  no_readable_channel: "Ce que je sais vient de canaux dont tu n'es pas membre. Je n'en dis rien.",
  knowledge_unavailable: 'Base de connaissance indisponible. Réessayer a un sens.',
};

export function refuse(reason: SearchVerdict) {
  const hint = VERDICT_HINTS[reason];
  return hint ? { found: false as const, reason, hint } : { found: false as const, reason };
}

export async function admit(
  directory: PersonDirectoryPort,
  requesterId: string,
  person: string | undefined,
): Promise<{ requester: Requester; target: string | null } | { reason: SearchVerdict }> {
  let requesterPerson: DirectoryPerson | null = null;
  try {
    requesterPerson = await directory.findBySlackUserId(requesterId);
  } catch (error) {
    logger.warn('Knowledge — annuaire indisponible, demandeur traité comme inconnu', {
      requesterId,
      error,
    });
  }

  const requester: Requester = { slackUserId: requesterId, subject: requesterPerson };

  const nominative = classifyPerson(person, requesterId, requesterPerson);
  if (nominative.kind === 'unparsable') {
    return { reason: 'person_not_resolved' };
  }

  if (nominative.kind === 'other') {
    const verdict = authorizeOtherMemoryRead(requester);
    if (!verdict.allowed) {
      logger.warn('Knowledge — recherche nominative refusée', {
        scope: 'knowledge_base',
        requesterId,
        reason: verdict.reason,
      });
      return { reason: verdict.reason };
    }
  }

  if (nominative.kind === 'self') {
    const verdict = authorizeMemoryRead(requester, requesterId);
    if (!verdict.allowed) {
      return { reason: verdict.reason };
    }
  }

  const target = await resolveTarget(directory, nominative);
  if (target === 'not_found') {
    return { reason: 'person_not_found' };
  }

  return { requester, target };
}

type Nominative =
  | { readonly kind: 'none' }
  | { readonly kind: 'unparsable' }
  | { readonly kind: 'self'; readonly slackUserId: string }
  | { readonly kind: 'other'; readonly slackUserId?: string; readonly email?: string };

function classifyPerson(
  raw: string | undefined,
  requesterId: string,
  requesterPerson: DirectoryPerson | null,
): Nominative {
  const value = raw?.trim();
  if (!value) {
    return { kind: 'none' };
  }

  if (SLACK_USER_ID_RE.test(value)) {
    const slackUserId = value.toUpperCase();
    return slackUserId === requesterId.toUpperCase()
      ? { kind: 'self', slackUserId: requesterId }
      : { kind: 'other', slackUserId };
  }

  if (!value.includes('@')) {
    return { kind: 'unparsable' };
  }

  const email = value.toLowerCase();
  const ownEmail = requesterPerson?.email?.trim().toLowerCase();

  return ownEmail && email === ownEmail
    ? { kind: 'self', slackUserId: requesterId }
    : { kind: 'other', email };
}

async function resolveTarget(
  directory: PersonDirectoryPort,
  nominative: Nominative,
): Promise<string | null | 'not_found'> {
  if (nominative.kind === 'none' || nominative.kind === 'unparsable') {
    return null;
  }
  if (nominative.kind === 'self') {
    return nominative.slackUserId;
  }

  if (nominative.slackUserId) {
    return nominative.slackUserId;
  }

  const person = await directory.findByEmail(nominative.email!);
  return person?.slackUserId ?? 'not_found';
}
