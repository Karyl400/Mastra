import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import { logger } from '../../../../shared/logger';
import { fullName } from '../../../../shared/name-matching';
import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';

export const MAX_NAME_CANDIDATES = 5;

const MIN_NAME_LENGTH = 2;

const NO_MATCH_HINT =
  "Ce nom ne correspond à personne, ni parmi les employés enregistrés ni dans l'annuaire " +
  "Slack. N'invente ni identifiant ni adresse : demande l'email de la " +
  'personne, ou son orthographe exacte.';

const AMBIGUOUS_HINT =
  'Plusieurs personnes portent ce nom. Ne choisis pas : demande laquelle, en citant ces noms.';

const DIRECTORY_ONLY_HINT =
  "Cette personne est dans Slack mais n'a aucun dossier d'onboarding : getEmployeeProfile " +
  "et les rappels ne fonctionneront pas pour elle. N'invente aucun identifiant interne ; " +
  'dis-le simplement.';

export function makeFindPersonByName(repo: EmployeeRepository, directory?: DirectoryRepository) {
  return createTool({
    id: 'findPersonByName',
    description:
      "Retrouve une personne par son nom ou son prénom : son dossier d'onboarding si elle " +
      "en a un, sinon l'annuaire Slack. Renvoie found=false (jamais une exception) si le " +
      'nom est inconnu ou porté par plusieurs personnes.',
    inputSchema: z.object({
      name: z
        .string()
        .min(MIN_NAME_LENGTH)
        .max(80)
        .describe('Nom, prénom ou nom complet — accents et casse indifférents'),
    }),
    execute: async (data, _ctx) => {
      const query = String(data.name).trim();

      if (query.length < MIN_NAME_LENGTH) {
        return { found: false as const, reason: 'no_match' as const, hint: NO_MATCH_HINT };
      }

      logger.info('Recherche personne par nom', { queryLength: query.length });

      const employees = await repo.findByName(query, MAX_NAME_CANDIDATES + 1);

      if (employees.length === 1) {
        const found = employees[0]!;
        return {
          found: true as const,
          source: 'employees' as const,
          employee: {
            id: found.id,
            firstName: sanitizeDisplayName(found.firstName),
            lastName: sanitizeDisplayName(found.lastName),
            position: found.position,
            status: found.status,
          },
        };
      }

      if (employees.length > 1) {
        return ambiguous(employees.map((e) => label(e.firstName, e.lastName, e.position)));
      }

      const members = directory
        ? (await directory.findByName(query, MAX_NAME_CANDIDATES + 1)).filter(
            (m) => !m.isBot && !m.isDeleted,
          )
        : [];

      if (members.length === 1) {
        const member = members[0]!;
        logger.info("Personne absente de la base, résolue par l'annuaire Slack", {
          slackUserId: member.slackUserId,
          linked: Boolean(member.employeeId),
        });

        return {
          found: true as const,
          source: 'slack_directory' as const,
          person: {
            slackUserId: member.slackUserId,
            firstName: sanitizeDisplayName(member.firstName),
            lastName: sanitizeDisplayName(member.lastName),
            title: sanitizeDisplayName(member.title),
            employeeId: member.employeeId,
          },
          ...(member.employeeId ? {} : { hint: DIRECTORY_ONLY_HINT }),
        };
      }

      if (members.length > 1) {
        return ambiguous(members.map((m) => label(m.firstName, m.lastName, m.title)));
      }

      return { found: false as const, reason: 'no_match' as const, hint: NO_MATCH_HINT };
    },
  });
}

function label(firstName: string | null, lastName: string | null, role: string | null): string {
  [firstName, lastName, role] = [
    sanitizeDisplayName(firstName),
    sanitizeDisplayName(lastName),
    sanitizeDisplayName(role),
  ];
  const name = fullName(firstName, lastName) || '(sans nom)';
  return role ? `${name} — ${role}` : name;
}

function ambiguous(all: readonly string[]) {
  logger.info('Nom ambigu — résolution laissée à l’humain', { count: all.length });

  return {
    found: false as const,
    reason: 'ambiguous' as const,
    candidates: all.slice(0, MAX_NAME_CANDIDATES),
    truncated: all.length > MAX_NAME_CANDIDATES,
    hint: AMBIGUOUS_HINT,
  };
}
