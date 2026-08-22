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

export function topRoleClaimReply(input: {
  readonly declaredPosition: string;
  readonly holderName: string | null;
  readonly informed: boolean;
}): string {
  const holder = input.holderName?.trim()
    ? `et c'est *${input.holderName.trim()}* aujourd'hui`
    : 'et ce rôle est déjà attribué';

  const contact = input.informed
    ? 'Je viens de lui écrire pour que vous en parliez ensemble.'
    : "Je n'ai pas réussi à lui écrire — dis-le-lui directement.";

  return (
    `J'ai noté « ${input.declaredPosition} » sur ton dossier. Un point à savoir : ` +
    `chez Kisso, une seule personne porte ce rôle, ${holder}. ${contact}\n\n` +
    `Ton dossier reste enregistré tel que tu me l'as donné — un intitulé de poste ` +
    `n'ouvre aucun accès ici, et rien ne change de ton côté.`
  );
}
