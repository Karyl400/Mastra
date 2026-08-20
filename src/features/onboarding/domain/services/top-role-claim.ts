import { normalizeIntentText } from '../../../../shared/intent-text';

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

const TOP_ROLE_PHRASES: readonly string[] = [
  'general manager',
  'directeur general',
  'directrice generale',
  'direction generale',
  'chief executive',
  'ceo',
  'pdg',
];

export function declaresTopRole(position: string | null | undefined): boolean {
  const normalized = normalizeIntentText(position ?? '');
  if (normalized.length === 0) return false;

  const words = normalized.split(WORD_SEPARATOR).filter(Boolean);
  if (words.length === 0) return false;

  const haystack = ` ${words.join(' ')} `;
  return TOP_ROLE_PHRASES.some((phrase) => haystack.includes(` ${phrase} `));
}

export function topRoleClaimNotice(input: {
  readonly newcomerName: string;
  readonly declaredPosition: string;
  readonly slackUserId: string;
}): string {
  return (
    `*${input.newcomerName}* vient de compléter son dossier en se déclarant ` +
    `« ${input.declaredPosition} ».\n\n` +
    `Je te préviens parce que c'est le poste qui te désigne. *Rien n'a changé de son côté* : ` +
    `un intitulé de poste n'accorde aucun droit ici, elle reste sur son seul dossier.\n\n` +
    `Tu es au courant, et tu approuves ? Si oui, la portée se donne à la main :\n` +
    `\`npm run role:set -- --slack-user-id ${input.slackUserId} --apply\`\n` +
    `Si non, il n'y a rien à défaire — dis-le-lui simplement.`
  );
}
