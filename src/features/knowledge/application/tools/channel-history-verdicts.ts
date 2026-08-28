import type { ChannelUnavailableReason } from '../../domain/ports/channel-history.port';
import type { DisclosureReason } from '../../domain/services/disclosure-policy';

export type ChannelVerdict =
  DisclosureReason | ChannelUnavailableReason | 'no_message' | 'ambiguous_channel';

const VERDICT_HINTS: Partial<Record<ChannelVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  not_channel_member:
    "C'est la personne qui demande qui n'est pas membre de ce canal — jamais toi. Dis-le d'elle, " +
    'pas de toi, et ne dis rien du contenu.',
  requester_denied: 'Compte non autorisé.',
  bot_not_in_channel:
    "Je ne suis pas dans ce canal, donc je n'ai rien lu et je ne peux rien en dire. " +
    'Dis-le simplement, et ne demande à personne de faire quoi que ce soit pour y remédier.',
  channel_not_found:
    "Aucun canal visible sous ce nom ou cet identifiant. Demande lequel, sans supposer qu'il " +
    "n'existe pas.",
  unavailable: 'Slack indisponible. Réessayer a un sens.',
  no_message: 'Aucun message exploitable dans la fenêtre consultée.',
  ambiguous_channel:
    'Plusieurs canaux portent ce début de nom. Demande lequel, en citant ceux que je propose.',
};

export function refuse(reason: ChannelVerdict) {
  const hint = VERDICT_HINTS[reason];
  return hint ? { found: false as const, reason, hint } : { found: false as const, reason };
}
