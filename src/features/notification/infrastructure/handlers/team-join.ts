import { logger } from '../../../../shared/logger';
import { buildWelcomeBlocks, firstWordOf, greet, restAfterFirstWord } from '../ui/welcome-blocks';
import type { NewcomerIdentity } from '../../../onboarding/domain/services/newcomer-identity';
import type { SlackHandlerInternals } from './handler-internals';
import type { SlackTeamJoinEvent, SlackTeamJoinUser } from './slack-event.types';

export async function handleTeamJoin(
  self: SlackHandlerInternals,
  event: SlackTeamJoinEvent,
): Promise<void> {
  const user = event.user;
  if (!user?.id) {
    logger.warn('team_join without a user id, skipping');
    return;
  }

  const joinedAt = new Date().toISOString();

  try {
    const identity = await resolveNewcomer(self, user);
    logger.info('Welcoming a newcomer', {
      userId: user.id,
      hasEmail: Boolean(identity.email),
    });

    await recordNewcomer(self, user.id, identity, joinedAt);
    const joinedNames = await inviteToWelcomeChannels(self, user.id);

    await self.chatProvider.sendBlocks(
      user.id,
      greet(identity.firstName ?? ''),
      buildWelcomeBlocks({ ...identity, joinedAt }, joinedNames),
    );
  } catch (error) {
    logger.error('Unable to send the welcome DM', { error, userId: user.id });
  }
}

async function recordNewcomer(
  self: SlackHandlerInternals,
  slackUserId: string,
  identity: NewcomerIdentity,
  joinedAt: string,
): Promise<void> {
  const repo = self.getDirectoryRepo();
  if (!repo) return;

  const realName = [identity.firstName, identity.lastName].filter(Boolean).join(' ');

  try {
    await repo.upsertFacts(
      {
        slackUserId,
        teamId: '',
        email: identity.email ?? null,
        realName,
        displayName: realName,
        firstName: identity.firstName ?? null,
        lastName: identity.lastName ?? null,
        title: null,
        isBot: false,
        isAdmin: false,
        isRestricted: false,
        isUltraRestricted: false,
        isDeleted: false,
      },
      new Date(joinedAt),
    );
  } catch (error) {
    logger.error('Unable to record the newcomer in the directory', { error, slackUserId });
  }
}

async function inviteToWelcomeChannels(
  self: SlackHandlerInternals,
  slackUserId: string,
): Promise<readonly string[]> {
  if (!self.welcomeChannels) return [];

  try {
    const report = await self.welcomeChannels.run(slackUserId);
    return report.joinedNames;
  } catch (error) {
    logger.error('Welcome channel invitations threw', { error, slackUserId });
    return [];
  }
}

async function resolveNewcomer(
  self: SlackHandlerInternals,
  user: SlackTeamJoinUser,
): Promise<NewcomerIdentity> {
  const fromPayload: NewcomerIdentity = {
    slackUserId: user.id ?? '',
    firstName: user.profile?.first_name || firstWordOf(user.real_name),
    lastName: user.profile?.last_name || restAfterFirstWord(user.real_name),
    email: user.profile?.email ?? null,
  };

  if (fromPayload.email || !user.id) return fromPayload;

  try {
    const member = await self.workspaceProvider.findUserById(user.id);
    if (!member) return fromPayload;
    return {
      slackUserId: fromPayload.slackUserId,
      firstName: fromPayload.firstName || member.firstName,
      lastName: fromPayload.lastName || member.lastName,
      email: member.email,
    };
  } catch (error) {
    logger.warn('Directory lookup failed for a newcomer, continuing without email', {
      error,
      userId: user.id,
    });
    return fromPayload;
  }
}
