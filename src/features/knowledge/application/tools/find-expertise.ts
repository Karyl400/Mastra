import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import type { EmployeeRepository } from '../../../employee/domain/ports/employee.repository';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import { fullName, matchesName } from '../../../../shared/name-matching';
import { logger } from '../../../../shared/logger';
import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';

const MAX_EXPERTS = 6;

const MAX_LABEL_CHARS = 44;

const NO_MATCH_HINT =
  'Personne ne le mentionne dans son poste déclaré. Dis-le, et n’invente aucun nom.';

const DIRECTORY_DOWN_HINT =
  'Tu n’as pas pu consulter l’annuaire : ne conclus PAS que personne ne fait ça. Dis que la ' +
  'recherche a échoué et propose de réessayer.';

const PARTIAL_SEARCH_HINT =
  'Une des deux sources était indisponible : la recherche est incomplète. Dis que tu n’as ' +
  'trouvé personne DANS CE QUE TU AS PU CONSULTER, sans en faire une certitude.';

interface SourceResult {
  readonly available: boolean;
  readonly experts: Expert[];
}

export interface FindExpertiseDeps {
  readonly directoryRepo: DirectoryRepository;
  readonly employeeRepo: Pick<EmployeeRepository, 'findAll'>;
  readonly interviewRepo?: Pick<OnboardingInterviewRepository, 'listAll'>;
}

interface Expert {
  readonly key: string;
  readonly label: string;
  readonly score: number;
  readonly source: 'directory' | 'employees';
}

export function makeFindExpertise(deps: FindExpertiseDeps) {
  return createTool({
    id: 'findExpertise',
    description:
      'Retrouve qui, dans l’entreprise, travaille sur un sujet donné, d’après le poste déclaré et ce que la personne a dit faire au quotidien. Rend des NOMS, jamais d’identifiant ni d’adresse.',
    inputSchema: z.object({
      skill: z.string().min(2).max(60).describe('Le sujet ou la compétence. Ex. « backend ».'),
    }),
    execute: async ({ skill }) => {
      const [fromDirectory, fromEmployees] = await Promise.all([
        matchDirectory(deps, skill),
        matchEmployees(deps, skill),
      ]);

      const experts = dedupe([...fromDirectory.experts, ...fromEmployees.experts]);

      if (experts.length === 0) {
        const bothDown = !fromDirectory.available && !fromEmployees.available;
        if (bothDown) {
          return {
            found: false,
            reason: 'directory_unavailable',
            hint: DIRECTORY_DOWN_HINT,
          };
        }

        const partial = !fromDirectory.available || !fromEmployees.available;
        return {
          found: false,
          reason: partial ? 'partial_search' : 'no_match',
          hint: partial ? PARTIAL_SEARCH_HINT : NO_MATCH_HINT,
        };
      }

      const ranked = [...experts].sort((a, b) => b.score - a.score);
      const shown = ranked.slice(0, MAX_EXPERTS);
      const truncated = ranked.length > MAX_EXPERTS;

      return {
        found: true,
        people: [
          ...(truncated ? [coverageLine(shown.length, ranked.length)] : []),
          ...shown.map((expert) => truncate(expert.label)),
        ],
        truncated,
      };
    },
  });
}

async function matchDirectory(deps: FindExpertiseDeps, skill: string): Promise<SourceResult> {
  try {
    const members = await deps.directoryRepo.listAll();
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

async function matchEmployees(deps: FindExpertiseDeps, skill: string): Promise<SourceResult> {
  try {
    const employees = await deps.employeeRepo.findAll();
    const dailyWork = await loadDailyWork(deps);

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
    const interviews = await deps.interviewRepo.listAll();
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

function dedupe(experts: readonly Expert[]): Expert[] {
  const seen = new Map<string, Expert['source']>();
  return experts.filter((expert) => {
    if (expert.key.length === 0) return false;
    const previous = seen.get(expert.key);
    if (previous !== undefined && previous !== expert.source) return false;
    seen.set(expert.key, expert.source);
    return true;
  });
}

function coverageLine(shown: number, total: number): string {
  return `(${shown} personnes montrées sur ${total} qui correspondent)`;
}

function displayNameOf(realName: string, displayName: string): string {
  return realName.trim() || displayName.trim();
}

function safePart(raw: string | null | undefined): string {
  return sanitizeDisplayName(raw);
}

function truncate(label: string): string {
  return label.length <= MAX_LABEL_CHARS ? label : `${label.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function normalizeKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
