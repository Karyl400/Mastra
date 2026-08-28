import { fullName, matchesName } from '../../../../shared/name-matching';
import { logger } from '../../../../shared/logger';
import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';
import type { FindExpertiseDeps } from './find-expertise';

export interface Expert {
  readonly key: string;
  readonly label: string;
  readonly score: number;
  readonly source: 'directory' | 'employees';
}

export interface SourceResult {
  readonly available: boolean;
  readonly experts: Expert[];
}

export async function matchDirectory(
  deps: FindExpertiseDeps,
  skill: string,
): Promise<SourceResult> {
  try {
    const members = await deps.directoryRepo.findAll();
    return {
      available: true,
      experts: members
        .filter((member) => !member.isBot && !member.isDeleted && member.title)
        .filter((member) => matchesName(skill, [member.title]))
        .map((member) => {
          const name = displayNameOf(member.realName, member.displayName);
          return {
            key: normalizeKey(name),
            label: `${safePart(name)} — ${safePart(member.title)}`,
            score: member.isRestricted || member.isUltraRestricted ? 2 : 3,
            source: 'directory' as const,
          };
        }),
    };
  } catch (error) {
    logger.warn('findExpertise: annuaire indisponible', { error: String(error) });
    return { available: false, experts: [] };
  }
}

export async function matchEmployees(
  deps: FindExpertiseDeps,
  skill: string,
  mayReadPrivateNotes: boolean,
): Promise<SourceResult> {
  try {
    const employees = await deps.employeeRepo.findAll();
    const dailyWork = mayReadPrivateNotes ? await loadDailyWork(deps) : new Map<string, string>();

    const experts: Expert[] = [];
    for (const employee of employees) {
      const name = fullName(employee.firstName, employee.lastName);
      const daily = dailyWork.get(employee.id) ?? '';
      const matchedPosition = Boolean(employee.position) && matchesName(skill, [employee.position]);
      const matchedDaily = Boolean(daily) && matchesName(skill, [daily]);
      if (!matchedPosition && !matchedDaily) continue;

      const label = matchedPosition
        ? `${safePart(name)} — ${safePart(employee.position)}`
        : `${safePart(name)} — d'après ce qu'iel a décrit de son travail au quotidien`;

      experts.push({
        key: normalizeKey(name),
        label,
        score: matchedPosition ? 3 : 1,
        source: 'employees' as const,
      });
    }

    return { available: true, experts };
  } catch (error) {
    logger.warn('findExpertise: dossiers indisponibles', { error: String(error) });
    return { available: false, experts: [] };
  }
}

async function loadDailyWork(deps: FindExpertiseDeps): Promise<Map<string, string>> {
  if (!deps.interviewRepo) return new Map();
  try {
    const interviews = await deps.interviewRepo.findAll();
    return new Map(
      interviews
        .filter((interview) => interview.dailyWork.trim())
        .map((interview) => [interview.employeeId, interview.dailyWork.trim()]),
    );
  } catch (error) {
    logger.warn('findExpertise: entretiens indisponibles — recherche sur les seuls postes', {
      error: String(error),
    });
    return new Map();
  }
}

function displayNameOf(realName: string, displayName: string): string {
  return realName.trim() || displayName.trim();
}

function safePart(raw: string | null | undefined): string {
  return sanitizeDisplayName(raw);
}

function normalizeKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
