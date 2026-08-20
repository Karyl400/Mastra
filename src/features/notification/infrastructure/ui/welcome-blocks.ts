import { type SlackBlock } from '../providers/slack.adapter';
import { type NewcomerIdentity } from '../../../onboarding/domain/services/newcomer-identity';
import { PROFILE_FORM_INVITE } from '../../../../shared/profile-request';
import { videoLine, writtenGuide } from '../../../../shared/onboarding-video';

export function firstWordOf(fullName: string | undefined): string {
  return (fullName ?? '').trim().split(/\s+/)[0] ?? '';
}

export function restAfterFirstWord(fullName: string | undefined): string {
  const [, ...rest] = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return rest.join(' ');
}

export function greet(firstName: string): string {
  return firstName ? `Bienvenue ${firstName} 👋` : 'Bienvenue 👋';
}

export function channelsLine(joinedNames: readonly string[]): string {
  if (joinedNames.length === 0) return '';
  const list = joinedNames.map((name) => `#${name}`).join(', ');
  return `\n\nJe t'ai ajouté à ${list} — tu y trouveras l'équipe.`;
}

export function buildWelcomeBlocks(
  prefill: NewcomerIdentity,
  joinedNames: readonly string[] = [],
): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${greet(prefill.firstName ?? '')}\n\n` +
          "Ravi de t'accueillir chez Kisso. Voilà comment on démarre." +
          channelsLine(joinedNames) +
          videoLine() +
          writtenGuide(),
      },
    },
  ];
}

export function buildProfileInviteBlocks(): SlackBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: PROFILE_FORM_INVITE + videoLine() + writtenGuide() },
    },
  ];
}
