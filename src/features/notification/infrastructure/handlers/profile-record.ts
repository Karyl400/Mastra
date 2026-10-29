import { logger } from '../../../../shared/logger';
import type { ProfileSnapshot } from '../../../onboarding/domain/services/profile-completion';
import {
  answersFromDirectory,
  answersFromRecord,
  type ProfileAnswers,
} from '../../../onboarding/domain/services/profile-chat';
import type { SlackHandlerInternals } from './handler-internals';

export async function knownProfileAnswers(
  self: SlackHandlerInternals,
  user: string | undefined,
): Promise<ProfileAnswers> {
  if (!user) {
    return {};
  }
  try {
    const member = await self.getDirectoryRepo()?.findBySlackUserId(user);
    const fromDirectory = answersFromDirectory(member);
    const record = await findProfileRecord(self, member);
    return record ? { ...fromDirectory, ...answersFromRecord(record) } : fromDirectory;
  } catch (error) {
    logger.warn('Dossier existant illisible — la conversation repart de zéro', {
      error: String(error),
    });
    return {};
  }
}

export async function findProfileRecord(
  self: SlackHandlerInternals,
  member: { employeeId?: string | null; email?: string | null } | null | undefined,
): Promise<ProfileSnapshot | null> {
  if (!self.profileRepo) {
    return null;
  }

  const employeeId = member?.employeeId;
  if (employeeId && self.profileRepo.findById) {
    const byId = await self.profileRepo.findById(employeeId);
    if (byId) {
      return byId;
    }
  }

  const email = member?.email;
  return email ? await self.profileRepo.findByEmail(email) : null;
}

export async function joinedAtOf(
  self: SlackHandlerInternals,
  slackUserId: string | undefined,
): Promise<string | undefined> {
  if (!slackUserId) {
    return undefined;
  }
  try {
    const member = await self.getDirectoryRepo()?.findBySlackUserId(slackUserId);
    return member?.firstSeenAt?.toISOString();
  } catch (error) {
    logger.debug('Date d’arrivée illisible — la création se poursuit', {
      error: String(error),
    });
    return undefined;
  }
}
