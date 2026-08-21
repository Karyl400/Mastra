/**
 * ════════════════════════════════════════════════════════════════════════════
 * LES MENTIONS SLACK SONT DES IDENTIFIANTS — le modèle les recopiait tels quels
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Dans un message Slack, une personne taguée n'apparaît pas sous son nom mais sous la forme
 * `<@U0BJ8F1AMNF>`. Les extraits partaient au modèle avec ces jetons bruts, et il les rendait
 * à l'identique : un résumé de canal disait « <@U0BJ8F1AMNF> a validé le déploiement », ce que
 * personne ne peut lire.
 *
 * ⚠️ **CE N'EST PAS UN PROBLÈME DE CONSIGNE, C'EST UN PROBLÈME DE DONNÉE.** On aurait pu
 * demander au modèle de résoudre les identifiants ; il n'a aucun moyen de le faire — l'annuaire
 * n'est pas dans sa fenêtre. Il aurait donc soit recopié, soit INVENTÉ un nom. Ce dépôt a
 * mesuré cinq consignes en échec pour des raisons plus faibles que celle-ci.
 *
 * ⚠️ **LES NOMS SONT ASSAINIS, et ce n'est pas une précaution de forme.** Un nom d'affichage
 * Slack est édité par son porteur : c'est un vecteur d'injection de premier ordre, et il entre
 * ici dans un texte qui part au modèle. C'est la raison pour laquelle `buildContextPreamble`
 * passe déjà par `sanitizeDisplayName`.
 *
 * ⚠️ **UN IDENTIFIANT INCONNU RESTE TEL QUEL.** Compte supprimé, bot, personne d'un autre
 * workspace : on n'invente pas un nom, et on ne met pas « quelqu'un » — cela effacerait la
 * distinction entre deux inconnus différents dans le même extrait. Un jeton brut est illisible ;
 * un faux nom est faux.
 */

/**
 * ⚠️ **UN SEUL QUANTIFICATEUR, ET LE TRI SE FAIT EN CODE.**
 *
 * La première version distinguait les deux formes par la regex :
 * `/<@([UW][A-Z0-9]{2,24})(?:\|[^>]{0,120})?>/`. Borner les longueurs n'a pas suffi —
 * `security/detect-unsafe-regex` compte la HAUTEUR D'ÉTOILE, et un quantificateur dans un groupe
 * optionnel en fait deux. Or ce motif s'applique au texte d'un message de canal, c'est-à-dire à
 * une entrée contrôlée par un tiers : ce dépôt a déjà payé un lot ReDoS entier, on ne rouvre pas
 * la porte à côté de celle qu'on ferme.
 *
 * On capture donc le contenu du jeton EN UNE FOIS — hauteur d'étoile 1, linéaire par
 * construction — et on le trie dans du code ordinaire, où la lecture est d'ailleurs plus claire.
 */
const SLACK_TOKEN = /<([@#])([^>]{1,140})>/g;

/** `U123`, `W123`, `C123|kisso-hq` → l'identifiant et son libellé éventuel. */
function splitToken(inner: string): { id: string; label?: string } {
  const bar = inner.indexOf('|');
  return bar === -1 ? { id: inner } : { id: inner.slice(0, bar), label: inner.slice(bar + 1) };
}

const USER_ID = /^[UW][A-Z0-9]{2,24}$/i;
const CHANNEL_ID = /^C[A-Z0-9]{2,24}$/i;

export type NameLookup = (slackUserId: string) => string | undefined;

/**
 * Remplace les mentions par des noms lisibles, sans jamais en inventer.
 *
 * Rend le texte inchangé si aucune mention n'y figure — le cas le plus fréquent, et il ne doit
 * rien coûter.
 */
export function resolveMentions(text: string, lookup: NameLookup): string {
  return text.replace(SLACK_TOKEN, (whole, sigil: string, inner: string) => {
    const { id, label } = splitToken(inner);

    if (sigil === '@' && USER_ID.test(id)) {
      const name = lookup(id)?.trim();
      return name ? `@${name}` : whole;
    }

    // Slack fournit déjà le nom du canal dans le jeton : il suffit de le préférer à l'identifiant.
    if (sigil === '#' && CHANNEL_ID.test(id) && label) return `#${label}`;

    return whole;
  });
}

/** Les identifiants mentionnés dans un lot de textes, sans doublon — pour ne résoudre qu'une fois. */
export function mentionedUserIds(texts: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SLACK_TOKEN)) {
      if (match[1] !== '@') continue;
      const { id } = splitToken(match[2]!);
      if (USER_ID.test(id)) ids.add(id.toUpperCase());
    }
  }
  return [...ids];
}
