import { logger } from '../../../../shared/logger';

/**
 * COUVERTURE DE CANAUX — le bot rejoint automatiquement les canaux publics.
 *
 * ----------------------------------------------------------------------------
 * LE DÉFAUT RÉPARÉ
 * ----------------------------------------------------------------------------
 * Le scope `channels:join` est accordé depuis longtemps, mais **il ne fait aucun `join`
 * implicite** : il autorise un appel `conversations.join` que personne n'émettait. État
 * mesuré : le bot était membre de 2 canaux sur 5. Dans les trois autres,
 * `chat.postMessage` échoue en `not_in_channel` — et cet échec est INVISIBLE pour
 * l'utilisateur, puisque le message d'erreur de repli est posté dans le même canal
 * inaccessible, donc échoue à son tour. Personne ne voit rien : ni l'humain, ni le bot.
 *
 * ----------------------------------------------------------------------------
 * TROIS ARBITRAGES, TOUS LISIBLES DANS LE RAPPORT
 * ----------------------------------------------------------------------------
 *  1. **Un canal privé n'est pas un échec.** `conversations.join` ne fonctionne QUE sur un
 *     canal public ; un privé exige une invitation humaine. On ne tente pas, on n'échoue pas,
 *     on NOMME l'état (`privateNotMember`) — même arbitrage que « non applicable ≠ dégradé »
 *     sur l'invitation Slack de l'onboarding, où compter le cas normal comme une dégradation
 *     aurait détruit le signal.
 *  2. **Idempotence.** Un canal déjà rejoint n'est pas retenté : `isMember` le dit avant tout
 *     appel, et Slack le redirait sans effet. Relancer ce service ne produit rien.
 *  3. **`missing_scope` interrompt la boucle.** C'est la seule issue qui appelle un geste
 *     humain (ajouter `channels:join`, **puis réinstaller l'app** — l'ajout seul ne propage
 *     rien). Continuer à interroger Slack N fois pour se faire refuser N fois consommerait du
 *     quota d'API pour ne rien apprendre de plus.
 */

/** Un canal, vu sous l'angle de l'accès. */
export interface ChannelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly isMember: boolean;
}

export type ChannelJoinStatus =
  | 'joined'
  | 'already_member'
  | 'not_public'
  | 'archived'
  | 'missing_scope'
  | 'not_found'
  | 'failed';

export interface ChannelJoinResult {
  readonly status: ChannelJoinStatus;
  readonly error?: string;
}

/**
 * La source de canaux, déclarée par son CONSOMMATEUR.
 *
 * Vocabulaire propre à la feature, et non le type de `notification/infrastructure` : la couche
 * `application` ne connaît pas Slack. L'adaptateur qui relie les deux vit en `infrastructure`,
 * seule couche où le croisement est légitime — même construction que `MemberSource`.
 */
export interface ChannelAccessSource {
  /** Balayage complet et BORNÉ. `truncated` = le plafond de pages a été touché. */
  listChannels(): Promise<{ channels: readonly ChannelSnapshot[]; truncated: boolean }>;
  join(channelId: string): Promise<ChannelJoinResult>;
}

export interface ChannelJoinFailure {
  readonly channelId: string;
  readonly name: string;
  readonly status: ChannelJoinStatus;
  readonly error?: string;
}

export interface ChannelRef {
  readonly id: string;
  readonly name: string;
}

export interface ChannelCoverageReport {
  readonly outcome: 'completed' | 'degraded';
  readonly scanned: number;
  /**
   * LA réponse à la demande : « accès à tous les canaux dans lesquels il est invité via leur
   * Channel ID ». Les canaux où le bot peut écrire à l'issue de ce passage — ceux dont il était
   * déjà membre, et ceux qu'il vient de rejoindre. Trié, donc stable d'un appel à l'autre.
   */
  readonly accessibleChannelIds: readonly string[];
  readonly joined: readonly ChannelRef[];
  readonly alreadyMember: number;
  /** État NOMMÉ, jamais une erreur : il faut une invitation humaine. */
  readonly privateNotMember: readonly ChannelRef[];
  readonly archivedSkipped: number;
  readonly failures: readonly ChannelJoinFailure[];
  /** Le scope `channels:join` manque : ajouter le scope PUIS réinstaller l'app. */
  readonly missingScope: boolean;
  /** Le balayage a touché son plafond de pages : la liste est PARTIELLE. */
  readonly truncated: boolean;
}

export interface ChannelCoverageDeps {
  readonly source: ChannelAccessSource;
}

export interface ChannelCoverageService {
  run(): Promise<ChannelCoverageReport>;
}

export function makeChannelCoverage(deps: ChannelCoverageDeps): ChannelCoverageService {
  return {
    async run(): Promise<ChannelCoverageReport> {
      const { channels, truncated } = await deps.source.listChannels();

      const accessible = new Set<string>();
      const joined: ChannelRef[] = [];
      const privateNotMember: ChannelRef[] = [];
      const failures: ChannelJoinFailure[] = [];
      let alreadyMember = 0;
      let archivedSkipped = 0;
      let missingScope = false;

      for (const channel of channels) {
        if (channel.isMember) {
          // Un canal privé dont on EST membre est parfaitement utilisable : c'est le cas de
          // `#engineer-karyl`. « Privé » ne vaut exclusion que combiné à « pas membre ».
          alreadyMember += 1;
          accessible.add(channel.id);
          continue;
        }

        if (channel.isArchived) {
          archivedSkipped += 1;
          continue;
        }

        if (channel.isPrivate) {
          privateNotMember.push({ id: channel.id, name: channel.name });
          continue;
        }

        if (missingScope) {
          // Le scope manque : la tentative suivante échouerait identiquement. On enregistre
          // l'échec sans consommer un appel de plus.
          failures.push({
            channelId: channel.id,
            name: channel.name,
            status: 'missing_scope',
            error: 'missing_scope',
          });
          continue;
        }

        // SÉQUENTIEL, pas `Promise.all` : `conversations.join` est plafonné par Slack, et une
        // salve simultanée sur un workspace fourni se ferait rate-limiter — le remède
        // produirait alors le symptôme qu'il vient corriger.
        const result = await deps.source.join(channel.id);

        switch (result.status) {
          case 'joined':
            joined.push({ id: channel.id, name: channel.name });
            accessible.add(channel.id);
            break;

          case 'already_member':
            // Course bénigne : quelqu'un a invité le bot entre le balayage et l'appel.
            alreadyMember += 1;
            accessible.add(channel.id);
            break;

          case 'not_public':
            // Slack contredit `is_private` (canal converti entre-temps) : état nommé, pas erreur.
            privateNotMember.push({ id: channel.id, name: channel.name });
            break;

          case 'archived':
            archivedSkipped += 1;
            break;

          case 'missing_scope':
            missingScope = true;
            failures.push({
              channelId: channel.id,
              name: channel.name,
              status: result.status,
              error: result.error,
            });
            break;

          default:
            failures.push({
              channelId: channel.id,
              name: channel.name,
              status: result.status,
              error: result.error,
            });
        }
      }

      const degraded = failures.length > 0 || truncated;

      const report: ChannelCoverageReport = {
        outcome: degraded ? 'degraded' : 'completed',
        scanned: channels.length,
        accessibleChannelIds: Array.from(accessible).sort(),
        joined,
        alreadyMember,
        privateNotMember,
        archivedSkipped,
        failures,
        missingScope,
        truncated,
      };

      if (missingScope) {
        logger.error(
          'Slack channel coverage blocked — the `channels:join` scope is missing. Add it in ' +
            'OAuth & Permissions, THEN reinstall the app: adding the scope alone propagates nothing.',
          { pending: failures.length },
        );
      } else if (degraded) {
        logger.error('Slack channel coverage degraded', {
          failures: report.failures,
          truncated,
        });
      } else {
        logger.info('Slack channel coverage completed', {
          scanned: report.scanned,
          joined: joined.length,
          alreadyMember,
          privateNotMember: privateNotMember.length,
          accessible: report.accessibleChannelIds.length,
        });
      }

      return report;
    },
  };
}
