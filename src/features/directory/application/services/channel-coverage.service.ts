import { logger } from '../../../../shared/logger';
import type { ChannelInventoryRepository } from '../../domain/ports/channel.repository';
import { errorMessage } from '../../../../shared/errors';

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
 *
 * ----------------------------------------------------------------------------
 * L'INVENTAIRE (2026-08-12) — OPTIONNEL, ET C'EST STRUCTUREL
 * ----------------------------------------------------------------------------
 * Quand un `ChannelInventoryRepository` est fourni, la passe enregistre AUSSI ce qu'elle a vu :
 * le canal, et les membres observés de ceux où le bot peut écrire.
 *
 * `inventory` est OPTIONNEL, et pas par confort : cette même fonction est câblée dans
 * `src/mastra/index.ts`, donc atteignable depuis le boot d'une fonction Vercel — celui qui est
 * SUR le chemin des 3 secondes d'ACK de Slack. Sans dépendance d'inventaire, la couverture ne
 * fait pas une seule écriture ni un seul appel `conversations.members` de plus qu'avant. C'est
 * le script de synchronisation, et lui seul, qui branche la persistance.
 *
 * ⚠️ Ce que l'inventaire produit est de l'OBSERVABILITÉ, jamais de l'autorisation : aucun
 * événement Slack ne l'invalide (`member_joined_channel` / `member_left_channel` ne sont pas
 * abonnés). Voir l'en-tête de `domain/entities/slack-channel.ts`.
 */

/** Un canal, vu sous l'angle de l'accès. */
export interface ChannelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly isMember: boolean;

  /**
   * ASSERTION de Slack (`conversations.list` → `num_members`), quand la source la porte.
   *
   * Optionnel et distinct du compte observé : ce sont deux mesures d'instants différents, et
   * leur écart est le seul signal de fraîcheur d'un inventaire qu'aucun événement ne dément.
   * `undefined` ou `null` = « Slack n'a rien affirmé », ce qu'un `0` ne dirait pas.
   */
  readonly memberCountReported?: number | null;
}

/** Résultat d'un balayage des membres d'un canal. `truncated` = le plafond a été touché. */
export interface ChannelMemberScan {
  readonly memberIds: readonly string[];
  readonly truncated: boolean;
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

  /**
   * Membres observés d'un canal — OPTIONNEL.
   *
   * Une source qui ne sait pas énumérer les membres couvre parfaitement les canaux : l'adhésion
   * et l'inventaire sont deux capacités séparées, et les fondre obligerait toute doublure de
   * test de la couverture à simuler une API dont elle n'a que faire.
   */
  listMembers?(channelId: string): Promise<ChannelMemberScan>;
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
  /** Présent seulement si un `ChannelInventoryRepository` a été fourni. */
  readonly inventory?: ChannelInventoryReport;
}

export interface ChannelInventoryFailure {
  readonly channelId: string;
  readonly name: string;
  readonly error: string;
}

export interface ChannelInventoryReport {
  /** Canaux enregistrés — TOUS ceux qui ont été vus, membres ou non. */
  readonly channelsRecorded: number;
  /** Canaux dont les membres ont été énumérés (ceux où le bot peut écrire). */
  readonly channelsWithMembers: number;
  /** Total des appartenances observées, tous canaux confondus. */
  readonly membersRecorded: number;
  /** Canaux dont l'énumération des membres a touché le plafond : la liste est PARTIELLE. */
  readonly truncatedChannels: readonly string[];
  readonly failures: readonly ChannelInventoryFailure[];
}

export interface ChannelCoverageDeps {
  readonly source: ChannelAccessSource;

  /**
   * OPTIONNEL — voir l'en-tête. Absent : aucune écriture, aucun appel supplémentaire, la
   * couverture se comporte exactement comme avant. C'est ce qui permet de laisser ce service
   * câblé au boot d'une fonction Vercel sans lui coûter une E/S.
   */
  readonly inventory?: ChannelInventoryRepository;

  /** Injectable pour les tests. Une seule horloge lue par passe : voir `run()`. */
  readonly now?: () => Date;
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
        // ARCHIVÉ D'ABORD, avant `isMember` : `chat.postMessage` échoue en `is_archived` quel
        // que soit `is_member`, et le bot RESTE membre des canaux archivés sous lui —
        // `listChannelMembershipsPage` ne pose délibérément pas `exclude_archived`, ils
        // arrivent donc bien ici. Tester l'adhésion en premier les faisait entrer dans
        // `accessibleChannelIds`, dont le contrat est « les canaux où le bot PEUT écrire » :
        // une promesse d'écriture certaine d'échouer, et un `archivedSkipped` qui ne les
        // comptait jamais.
        if (channel.isArchived) {
          archivedSkipped += 1;
          continue;
        }

        if (channel.isMember) {
          // Un canal privé dont on EST membre est parfaitement utilisable : c'est le cas de
          // `#engineer-karyl`. « Privé » ne vaut exclusion que combiné à « pas membre ».
          alreadyMember += 1;
          accessible.add(channel.id);
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

      const inventory = await recordInventory(deps, channels, accessible);

      const degraded = failures.length > 0 || truncated || isInventoryDegraded(inventory);

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
        ...(inventory ? { inventory } : {}),
      };

      logCoverage(report);

      return report;
    },
  };
}

/**
 * Journalise l'issue de la passe. Extrait de `run()` : la fonction porte déjà la boucle
 * d'adhésion et son `switch`, et empiler trois branches de journalisation par-dessus la rendait
 * illisible — la lire ne doit pas coûter plus que la comprendre.
 *
 * `missing_scope` d'abord : c'est la seule issue qui appelle un geste HUMAIN, et la noyer dans
 * le message générique de dégradation ferait manquer la seule chose à faire.
 */
function logCoverage(report: ChannelCoverageReport): void {
  if (report.missingScope) {
    logger.error(
      'Slack channel coverage blocked — the `channels:join` scope is missing. Add it in ' +
        'OAuth & Permissions, THEN reinstall the app: adding the scope alone propagates nothing.',
      { pending: report.failures.length },
    );
    return;
  }

  if (report.outcome === 'degraded') {
    logger.error('Slack channel coverage degraded', {
      failures: report.failures,
      truncated: report.truncated,
    });
    return;
  }

  logger.info('Slack channel coverage completed', {
    scanned: report.scanned,
    joined: report.joined.length,
    alreadyMember: report.alreadyMember,
    privateNotMember: report.privateNotMember.length,
    accessible: report.accessibleChannelIds.length,
    channelsRecorded: report.inventory?.channelsRecorded,
    membersRecorded: report.inventory?.membersRecorded,
  });
}

/**
 * Enregistre l'inventaire — canaux vus, et membres observés de ceux où le bot peut écrire.
 *
 * Rend `undefined` quand aucun repository n'est fourni, OU quand la source ne sait pas énumérer
 * les membres : la distinction compte, un rapport d'inventaire absent se lit « non demandé »
 * là qu'un rapport à zéro se lirait « demandé, rien trouvé ».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TROIS ARBITRAGES
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. **`isMember` enregistré est celui d'APRÈS la passe d'adhésion, pas celui du balayage
 *     initial.** Le canal que le bot vient de rejoindre est membre ; recopier l'instantané
 *     d'origine écrirait `is_member = 0` sur un canal où `chat.postMessage` fonctionne
 *     désormais, et le seul champ dont ce booléen décide (`not_in_channel`) serait faux dès la
 *     première ligne.
 *  2. **On n'énumère les membres QUE des canaux accessibles.** `conversations.members` répond
 *     `channel_not_found` sur un canal privé dont le bot n'est pas membre : appeler quand même
 *     fabriquerait un échec par canal privé à chaque passage, c'est-à-dire un rapport
 *     durablement « dégradé » pour un état parfaitement normal — l'arbitrage « non applicable ≠
 *     dégradé », déjà tranché ici pour `privateNotMember`.
 *  3. **L'échec d'un canal ne coule pas la passe.** Il est nommé, compté, et les autres canaux
 *     continuent. Un `throw` ferait perdre l'inventaire des canaux déjà lus pour une erreur sur
 *     le dernier.
 *
 * Une seule horloge est lue pour toute la passe : `replaceMembers` supprime les appartenances
 * dont le `synced_at` est ANTÉRIEUR à celui qu'on vient d'écrire. Deux horloges lues à deux
 * instants resteraient correctes, mais un même instant rend la passe lisible d'un seul coup
 * d'œil en base — tous les canaux d'un même balayage portent le même `synced_at`.
 */
async function recordInventory(
  deps: ChannelCoverageDeps,
  channels: readonly ChannelSnapshot[],
  accessible: ReadonlySet<string>,
): Promise<ChannelInventoryReport | undefined> {
  const repository = deps.inventory;
  const listMembers = deps.source.listMembers?.bind(deps.source);
  if (!repository || !listMembers) return undefined;

  const now = (deps.now ?? (() => new Date()))();

  const failures: ChannelInventoryFailure[] = [];
  const truncatedChannels: string[] = [];
  let channelsRecorded = 0;
  let channelsWithMembers = 0;
  let membersRecorded = 0;

  for (const channel of channels) {
    const outcome = await recordOneChannel(
      repository,
      listMembers,
      channel,
      accessible.has(channel.id),
      now,
    );

    if (outcome.error !== undefined) {
      failures.push({ channelId: channel.id, name: channel.name, error: outcome.error });
    }
    if (outcome.channelRecorded) channelsRecorded += 1;
    if (outcome.members !== undefined) {
      channelsWithMembers += 1;
      membersRecorded += outcome.members;
      if (outcome.truncated) truncatedChannels.push(channel.id);
    }
  }

  if (failures.length > 0 || truncatedChannels.length > 0) {
    logger.error('Slack channel inventory degraded', { failures, truncatedChannels });
  }

  return {
    channelsRecorded,
    channelsWithMembers,
    membersRecorded,
    truncatedChannels,
    failures,
  };
}

/** Ce qu'une passe a pu faire d'UN canal. Champs absents = l'étape n'a pas eu lieu. */
interface ChannelRecordOutcome {
  readonly channelRecorded: boolean;
  /** Nombre de membres enregistrés. `undefined` = ils n'ont pas été énumérés. */
  readonly members?: number;
  readonly truncated?: boolean;
  /** Message d'échec. `undefined` = aucun échec. */
  readonly error?: string;
}

/**
 * Enregistre UN canal, et ses membres s'il est accessible. Ne lève jamais : chaque échec est
 * rendu comme une valeur, pour que la passe continue sur les canaux suivants.
 */
async function recordOneChannel(
  repository: ChannelInventoryRepository,
  listMembers: (channelId: string) => Promise<ChannelMemberScan>,
  channel: ChannelSnapshot,
  isMember: boolean,
  now: Date,
): Promise<ChannelRecordOutcome> {
  try {
    await repository.upsertChannel(
      {
        channelId: channel.id,
        name: channel.name,
        isPrivate: channel.isPrivate,
        isArchived: channel.isArchived,
        isMember,
        // `?? null` : une source qui ne porte pas le champ n'affirme rien. On n'invente pas un
        // `0`, qui serait indiscernable d'un canal réellement vide.
        memberCountReported: channel.memberCountReported ?? null,
      },
      now,
    );
  } catch (error) {
    // Sans ligne de canal, l'appartenance violerait la clé étrangère : on n'essaie même pas.
    return { channelRecorded: false, error: errorMessage(error) };
  }

  if (!isMember) return { channelRecorded: true };

  try {
    const scan = await listMembers(channel.id);
    await repository.replaceMembers(channel.id, scan.memberIds, now);
    return {
      channelRecorded: true,
      members: scan.memberIds.length,
      truncated: scan.truncated,
    };
  } catch (error) {
    return { channelRecorded: true, error: errorMessage(error) };
  }
}

/** Un rapport d'inventaire ABSENT n'est pas dégradé : il n'a pas été demandé. */
function isInventoryDegraded(inventory: ChannelInventoryReport | undefined): boolean {
  if (!inventory) return false;
  return inventory.failures.length > 0 || inventory.truncatedChannels.length > 0;
}
