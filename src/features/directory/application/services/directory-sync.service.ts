import { logger } from '../../../../shared/logger';
import type { DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { MemberSource } from '../../domain/ports/member-source';
import type { DirectoryRepository } from '../../domain/ports/directory.repository';

/**
 * SYNCHRONISATION DE L'ANNUAIRE — Slack dit qui existe, la base s'en souvient.
 *
 * ----------------------------------------------------------------------------
 * CE QU'ELLE NE DOIT SURTOUT PAS FAIRE
 * ----------------------------------------------------------------------------
 * Écraser ce que NOUS avons appris. Trois colonnes n'existent que de notre côté :
 *
 *   • `dm_channel_id` — le canal `D…` d'une personne. Slack ne sait PAS nous le rendre
 *     (`conversations.list({ types: 'im' })` répond `missing_scope`, il faudrait `im:read`,
 *     qui n'est pas accordé). Il s'apprend au premier DM reçu, et une valeur perdue est perdue
 *     DÉFINITIVEMENT.
 *   • `employee_id` — le pont vers le métier.
 *   • `first_seen_at` — écrit une seule fois dans la vie de la ligne.
 *
 * Une synchronisation complète repasse sur TOUTES les lignes. Si elle réécrivait
 * l'enregistrement entier, chaque passage effacerait ces trois colonnes, sans erreur ni
 * avertissement — le mode d'échec exact de `documents.content`, perdu sur 6 lignes sur 6.
 *
 * La garantie ne vit pas ici : elle vit dans `upsertFacts`, dont le `set` énumère les champs un
 * à un et ne nomme jamais ces trois colonnes. Ce service **ne la contourne pas** — il n'écrit
 * QUE par `upsertFacts` et `linkEmployee`, jamais par un chemin qui verrait la ligne entière.
 *
 * ----------------------------------------------------------------------------
 * AUCUNE DÉGRADATION SILENCIEUSE
 * ----------------------------------------------------------------------------
 * Le rapport porte un `outcome` du même vocabulaire que `OnboardingOutcome`
 * (`completed | degraded`) et l'inventaire de ce qui a manqué. Un compteur « 42 membres
 * synchronisés » sans mention des 3 qui ont échoué se lit « tout va bien » — et ce dépôt a
 * déjà payé trois fois ce mensonge.
 */

/**
 * Le strict nécessaire de `EmployeeRepository` : une résolution par email.
 *
 * Interface déclarée ICI, par le CONSOMMATEUR, plutôt qu'importée de `employee/domain` : deux
 * features ne se référencent pas au niveau applicatif, c'est la règle structurante du dépôt
 * (`member-source.ts` et le port `employee` dupliqué par la feature `document` font le même
 * choix, documenté comme intentionnel). `EmployeeRepository` la satisfait structurellement, le
 * câblage n'a donc rien à adapter.
 */
export interface EmployeeDirectoryLookup {
  findByEmail(email: string): Promise<{ readonly id: string } | null>;
}

/**
 * La source consommée : le port `MemberSource`, plus — quand la source SAIT le dire — un aveu
 * de troncature.
 *
 * Optionnelle parce que `MemberSource.fetchAll()` rend un tableau nu, incapable par
 * construction d'avouer qu'il est incomplet. Une source qui l'ignore n'est pas moins correcte ;
 * elle est seulement moins bavarde, et le rapport le dira (`truncated: false` est alors une
 * absence d'information, pas une garantie — d'où le nom de la méthode, au passé).
 */
export interface DirectorySyncSource extends MemberSource {
  wasLastFetchTruncated?(): boolean;
}

export interface DirectorySyncFailure {
  readonly slackUserId: string;
  readonly error: string;
}

export interface DirectorySyncReport {
  /** `degraded` dès qu'un membre a échoué, qu'un rattachement a échoué, ou que le scan est tronqué. */
  readonly outcome: 'completed' | 'degraded';
  readonly scanned: number;
  readonly upserted: number;
  /** Rattachements `employee_id` NOUVEAUX. Un rattachement déjà en place n'est pas recompté. */
  readonly linked: number;
  readonly linkFailures: number;
  /** Borné (voir `MAX_REPORTED_FAILURES`) : le décompte, lui, ne l'est pas. */
  readonly failures: readonly DirectorySyncFailure[];
  readonly failureCount: number;
  /** Le balayage a touché son plafond de pages : l'annuaire est PARTIEL. */
  readonly truncated: boolean;
}

export interface DirectorySyncDeps {
  readonly source: DirectorySyncSource;
  readonly repository: DirectoryRepository;
  /**
   * Optionnel : sans lui, aucun rattachement `employee_id` n'est tenté et le rapport le dit
   * (`linked: 0`). L'absence d'annuaire employé n'est pas une dégradation — c'est une
   * configuration, exactement comme « pas de canal de département » ne rend pas une invitation
   * Slack dégradée.
   */
  readonly employees?: EmployeeDirectoryLookup;
  /** Injectable pour les tests ; la production passe l'heure réelle. */
  readonly now?: () => Date;
}

export interface DirectorySyncService {
  run(): Promise<DirectorySyncReport>;
}

/**
 * On ne rapporte pas 5 000 échecs.
 *
 * Le cas qui produit ce volume est connu d'avance : la table `slack_directory` n'a pas été
 * créée (le DDL vit dans `scripts/ddl-slack-directory.sql` et s'applique à la main, les
 * migrations `drizzle/` étant désynchronisées). CHAQUE ligne échoue alors avec le même
 * `no such table`. Un échantillon nomme la cause ; le décompte, lui, reste exact.
 */
const MAX_REPORTED_FAILURES = 10;

export function makeDirectorySync(deps: DirectorySyncDeps): DirectorySyncService {
  const now = deps.now ?? (() => new Date());

  return {
    async run(): Promise<DirectorySyncReport> {
      const members = await deps.source.fetchAll();
      const truncated = deps.source.wasLastFetchTruncated?.() ?? false;

      // Lu AVANT les upserts, en UN aller-retour : `upsertFacts` ne touche pas `employee_id`,
      // donc cette photo reste valable après. La forme « naturelle » — relire chaque ligne
      // après son upsert pour savoir si elle est rattachée — coûterait un aller-retour par
      // membre pour la même information.
      const knownLinks = await readKnownLinks(deps.repository);

      const failures: DirectorySyncFailure[] = [];
      let failureCount = 0;
      let upserted = 0;
      let linked = 0;
      let linkFailures = 0;

      for (const facts of members) {
        // Chaque membre est isolé : un profil malformé ne doit pas emporter l'annuaire entier.
        // Sans cette isolation, une seule ligne en échec laisserait la politique d'autorisation
        // sans aucun fait sur personne — c'est-à-dire sans aucune décision.
        try {
          await deps.repository.upsertFacts(facts, now());
          upserted += 1;
        } catch (error) {
          failureCount += 1;
          if (failures.length < MAX_REPORTED_FAILURES) {
            failures.push({ slackUserId: facts.slackUserId, error: describe(error) });
          }
          // Le rattachement suppose la ligne écrite : inutile de l'essayer.
          continue;
        }

        const outcome = await linkEmployeeIfPossible(facts, knownLinks, deps);
        if (outcome === 'linked') linked += 1;
        if (outcome === 'failed') linkFailures += 1;
      }

      const degraded = failureCount > 0 || linkFailures > 0 || truncated;

      const report: DirectorySyncReport = {
        outcome: degraded ? 'degraded' : 'completed',
        scanned: members.length,
        upserted,
        linked,
        linkFailures,
        failures,
        failureCount,
        truncated,
      };

      if (degraded) {
        // La ligne à chercher. Elle dit QUOI et POURQUOI — un booléen dirait qu'il faut
        // réparer, jamais quoi.
        logger.error('Directory sync degraded', {
          scanned: report.scanned,
          upserted: report.upserted,
          failureCount,
          linkFailures,
          truncated,
          sample: failures,
        });
      } else {
        logger.info('Directory sync completed', {
          scanned: report.scanned,
          upserted: report.upserted,
          linked,
        });
      }

      return report;
    },
  };
}

/** `slackUserId → employeeId`. Une panne de lecture n'annule pas la synchronisation. */
async function readKnownLinks(
  repository: DirectoryRepository,
): Promise<Map<string, string | null>> {
  try {
    const rows = await repository.listAll();
    return new Map(rows.map((row) => [row.slackUserId, row.employeeId]));
  } catch (error) {
    // Conséquence assumée et NOMMÉE : sans cette photo, chaque membre porteur d'un email fera
    // une résolution employé de plus. C'est du travail en trop, jamais une perte de donnée —
    // `linkEmployee` est idempotent quand il repose la même valeur.
    logger.warn('Directory sync could not read existing links — employee lookups will repeat', {
      error: describe(error),
    });
    return new Map();
  }
}

/**
 * Rattache `employee_id` quand l'email désigne un employé enregistré.
 *
 * ⚠️ ON NE DÉTACHE JAMAIS ICI, alors que le port le permet (`linkEmployee(id, null)`). Un
 * détachement automatique se déclencherait au premier email introuvable — profil Slack modifié,
 * employé en cours de migration, `users:read.email` momentanément absent — et la personne
 * perdrait son pont vers le métier sans que rien ne le signale. Un rattachement qui manque se
 * refait au passage suivant ; un rattachement effacé ne se voit pas.
 */
async function linkEmployeeIfPossible(
  facts: DirectoryMemberFacts,
  knownLinks: Map<string, string | null>,
  deps: DirectorySyncDeps,
): Promise<'linked' | 'skipped' | 'failed'> {
  const employees = deps.employees;
  if (!employees) return 'skipped';

  // Un bot n'a pas d'employé, un compte désactivé n'a plus à en gagner un, et sans email il
  // n'y a rien à résoudre. Trois filtres qui épargnent autant d'allers-retours en base.
  if (facts.isBot || facts.isDeleted) return 'skipped';

  const email = facts.email?.trim();
  if (!email) return 'skipped';

  if (knownLinks.get(facts.slackUserId)) return 'skipped';

  try {
    const employee = await employees.findByEmail(email);
    if (!employee) return 'skipped';

    await deps.repository.linkEmployee(facts.slackUserId, employee.id);
    knownLinks.set(facts.slackUserId, employee.id);

    logger.info('Directory member linked to an employee', {
      slackUserId: facts.slackUserId,
      employeeId: employee.id,
    });
    return 'linked';
  } catch (error) {
    logger.warn('Directory employee link failed', {
      slackUserId: facts.slackUserId,
      error: describe(error),
    });
    return 'failed';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
