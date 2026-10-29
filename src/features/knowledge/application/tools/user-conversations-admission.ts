import { logger } from '../../../../shared/logger';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../domain/ports/person-directory.port';
import type { DisclosureReason } from '../../domain/services/disclosure-policy';

const SLACK_USER_ID_RE = /^U[A-Z0-9]{4,}$/i;

export type MemoryVerdict =
  | DisclosureReason
  | 'person_not_resolved'
  | 'person_not_found'
  | 'no_recorded_conversation'
  | 'memory_unavailable';

const VERDICT_HINTS: Partial<Record<MemoryVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  insufficient_privilege: 'Tu ne peux montrer que les échanges de la personne qui te parle.',
  requester_denied: 'Compte non autorisé.',
  person_not_resolved: 'Demande un email ou un identifiant Slack (U…).',
  person_not_found: "Personne inconnue de l'annuaire.",
  no_recorded_conversation: "Cette personne n'a jamais échangé en direct avec toi.",
  memory_unavailable: 'Mémoire indisponible. Réessayer a un sens.',
};

export function refuse(reason: MemoryVerdict) {
  const hint = VERDICT_HINTS[reason];
  return hint ? { found: false as const, reason, hint } : { found: false as const, reason };
}

export async function resolveTarget(
  directory: PersonDirectoryPort,
  raw: string,
): Promise<DirectoryPerson | null | 'unparsable'> {
  const value = raw.trim();

  if (SLACK_USER_ID_RE.test(value)) {
    return directory.findBySlackUserId(value.toUpperCase());
  }
  if (value.includes('@')) {
    return directory.findByEmail(value.toLowerCase());
  }

  return 'unparsable';
}

export function designatesRequester(
  asked: string,
  requesterId: string,
  requesterPerson: DirectoryPerson | null,
): boolean {
  const value = asked.trim();

  if (SLACK_USER_ID_RE.test(value)) {
    return value.toUpperCase() === requesterId.toUpperCase();
  }

  const ownEmail = requesterPerson?.email?.trim().toLowerCase();
  return Boolean(ownEmail) && value.toLowerCase() === ownEmail;
}

export async function lookUpRequester(
  directory: { findBySlackUserId(id: string): Promise<DirectoryPerson | null> },
  requesterId: string,
): Promise<DirectoryPerson | null> {
  try {
    return await directory.findBySlackUserId(requesterId);
  } catch (error) {
    logger.warn('Knowledge — annuaire indisponible, demandeur traité comme inconnu', {
      requesterId,
      error,
    });
    return null;
  }
}
