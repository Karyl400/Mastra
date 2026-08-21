import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';
import { fullName } from '../../../../shared/name-matching';
import { mentionedUserIds, type NameLookup } from '../../domain/services/mention-names';
import { logger } from '../../../../shared/logger';

/** Ce que ce service attend d'un annuaire : une lecture, rien d'autre. */
export interface NameSource {
  findBySlackUserId(slackUserId: string): Promise<{
    readonly realName?: string | null;
    readonly displayName?: string | null;
    readonly firstName?: string | null;
    readonly lastName?: string | null;
  } | null>;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * DE `<@U0BJ8F1AMNF>` À « @Karyl SOUMAILA »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **ON NE RÉSOUT QUE LES IDENTIFIANTS RÉELLEMENT MENTIONNÉS.** Le cas fréquent est zéro
 * mention : on ne doit alors faire AUCUNE lecture. Charger tout l'annuaire « au cas où » ferait
 * payer une requête à chaque consultation pour un besoin qui n'existe pas la plupart du temps —
 * et ce dépôt compte ses allers-retours.
 *
 * ⚠️ **LES NOMS SONT ASSAINIS.** Un nom d'affichage Slack est édité par son porteur, et il entre
 * ici dans un texte qui part au modèle : c'est un vecteur d'injection de premier ordre. Même
 * raison que `buildContextPreamble`.
 *
 * ⚠️ **UNE PANNE D'ANNUAIRE NE FAIT PAS ÉCHOUER LA CONSULTATION.** Elle rend les jetons bruts,
 * comme avant ce correctif. Un résumé illisible vaut mieux qu'un résumé absent — et c'est le
 * seul comportement qui dégrade dans le bon sens : on n'invente aucun nom.
 */
export async function buildNameLookup(
  directory: NameSource | null | undefined,
  texts: readonly string[],
): Promise<NameLookup | undefined> {
  if (!directory) return undefined;

  const ids = mentionedUserIds(texts);
  if (ids.length === 0) return undefined;

  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const member = await directory.findBySlackUserId(id);
        if (!member) return;
        const name =
          sanitizeDisplayName(member.realName) ||
          sanitizeDisplayName(member.displayName) ||
          fullName(sanitizeDisplayName(member.firstName), sanitizeDisplayName(member.lastName));
        if (name) names.set(id, name);
      } catch (error) {
        // Une lecture ratée laisse le jeton brut. On le journalise une fois, sans faire échouer.
        logger.warn('Mention non résolue — jeton laissé tel quel', {
          slackUserId: id,
          error: String(error),
        });
      }
    }),
  );

  if (names.size === 0) return undefined;
  return (id: string) => names.get(id.toUpperCase());
}
