import type { ConversationExcerpt } from '../../domain/entities/conversation-excerpt';
import type { ChannelMessage } from '../../domain/ports/channel-history.port';
import type { PersonDirectoryPort } from '../../domain/ports/person-directory.port';
import { describeCoverageForHuman, projectExcerpts } from '../../domain/services/excerpt-budget';
import { buildNameLookup } from '../services/directory-names';

export async function projectChannelHistory(
  directory: PersonDirectoryPort,
  messages: readonly ChannelMessage[],
): Promise<{
  lines: string;
  shown: number;
  coverage?: string;
  humanCoverage?: string;
}> {
  const excerpts: ConversationExcerpt[] = messages.map((message) => ({
    source: 'channel',
    speaker: message.authorLabel,
    text: message.text,
    at: message.at,
  }));

  const nameLookup = await buildNameLookup(
    directory,
    excerpts.map((excerpt) => excerpt.text),
  );
  const { lines, shown, coverage } = projectExcerpts(excerpts, nameLookup);

  const humanCoverage = describeCoverageForHuman(excerpts, shown);

  return { lines, shown, coverage, humanCoverage };
}
