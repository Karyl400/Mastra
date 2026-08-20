import { logger } from '../../../../shared/logger';
import type { DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { MemberSource } from '../../domain/ports/member-source';
import type { DirectoryRepository } from '../../domain/ports/directory.repository';
import { errorMessage } from '../../../../shared/errors';

export interface EmployeeDirectoryLookup {
  findByEmail(email: string): Promise<{ readonly id: string } | null>;
}

export interface DirectorySyncSource extends MemberSource {
  wasLastFetchTruncated?(): boolean;
}

export interface DirectorySyncFailure {
  readonly slackUserId: string;
  readonly error: string;
}

export interface DirectorySyncReport {
  readonly outcome: 'completed' | 'degraded';
  readonly scanned: number;
  readonly upserted: number;
  readonly linked: number;
  readonly linkFailures: number;
  readonly failures: readonly DirectorySyncFailure[];
  readonly failureCount: number;
  readonly truncated: boolean;
}

export interface DirectorySyncDeps {
  readonly source: DirectorySyncSource;
  readonly repository: DirectoryRepository;
  readonly employees?: EmployeeDirectoryLookup;
  readonly now?: () => Date;
}

export interface DirectorySyncService {
  run(): Promise<DirectorySyncReport>;
}

const MAX_REPORTED_FAILURES = 10;

export function makeDirectorySync(deps: DirectorySyncDeps): DirectorySyncService {
  const now = deps.now ?? (() => new Date());

  return {
    async run(): Promise<DirectorySyncReport> {
      const members = await deps.source.fetchAll();
      const truncated = deps.source.wasLastFetchTruncated?.() ?? false;

      const knownLinks = await readKnownLinks(deps.repository);

      const failures: DirectorySyncFailure[] = [];
      let failureCount = 0;
      let upserted = 0;
      let linked = 0;
      let linkFailures = 0;

      for (const facts of members) {
        try {
          await deps.repository.upsertFacts(facts, now());
          upserted += 1;
        } catch (error) {
          failureCount += 1;
          if (failures.length < MAX_REPORTED_FAILURES) {
            failures.push({ slackUserId: facts.slackUserId, error: errorMessage(error) });
          }
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

async function readKnownLinks(
  repository: DirectoryRepository,
): Promise<Map<string, string | null>> {
  try {
    const rows = await repository.listAll();
    return new Map(rows.map((row) => [row.slackUserId, row.employeeId]));
  } catch (error) {
    logger.warn('Directory sync could not read existing links — employee lookups will repeat', {
      error: errorMessage(error),
    });
    return new Map();
  }
}

async function linkEmployeeIfPossible(
  facts: DirectoryMemberFacts,
  knownLinks: Map<string, string | null>,
  deps: DirectorySyncDeps,
): Promise<'linked' | 'skipped' | 'failed'> {
  const employees = deps.employees;
  if (!employees) return 'skipped';

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
      error: errorMessage(error),
    });
    return 'failed';
  }
}
