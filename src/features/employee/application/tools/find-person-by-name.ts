import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import { logger } from '../../../../shared/logger';
import { fullName } from '../../../../shared/name-matching';
import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';
import { mayHoldKeyFor } from '../../../../shared/slack-request-context';

/**
 * ⚠️ Le hint dit au modèle ce qu'il PEUT faire, pas ce qui lui est refusé — un refus détaillé
 * l'inviterait à contourner, et ce dépôt a mesuré cinq consignes en échec. Il ne nomme donc ni
 * la garde, ni le niveau, ni ce qui manque.
 */
const WITHHELD_HINT =
  'Tu as le nom, pas son identifiant interne. Poursuis la conversation avec le nom ; pour ' +
  'agir sur son dossier, la personne concernée ou le General Manager doit le demander.';

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

/**
 * ⚠️ **LA CLÉ NE SORT QUE POUR QUI PEUT S'EN SERVIR — 2026-08-21.**
 *
 * Ce résolveur n'a jamais consulté de garde : il rendait l'UUID interne, le poste et le statut
 * de n'importe qui, à n'importe qui, depuis n'importe quel message Slack — invité mono-canal
 * compris. Sur treize outils, dix consultaient une frontière ; celui-ci et son voisin par email
 * étaient les deux exceptions qui rendent un IDENTIFIANT.
 *
 * ⚠️ **ON NE BLOQUE PAS, ON RÉDUIT.** La contrepartie est écrite noir sur blanc dans ce dépôt :
 * « un agent qui ne sait pas résoudre une personne ne peut RIEN faire », et le câblage manquant
 * a déjà produit une boucle sans sortie le 2026-08-10. Une garde bloquante casserait le produit
 * pour fermer une fuite modeste.
 *
 * L'UUID est la CLÉ : c'est lui qui rend l'appel SUIVANT possible. Un demandeur non autorisé
 * garde donc de quoi poursuivre le dialogue (le nom) et perd de quoi agir. Il ne perd rien
 * d'utile au passage : `getEmployeeProfile`, `generateDocument`, `sendNotification` et
 * `scheduleReminder` lui refuseraient déjà cet identifiant. Ce qu'on retire, c'est l'illusion
 * qu'il pourrait s'en servir — et l'énumération qui va avec.
 *
 * ⚠️ **Hors contexte Slack, on retient AUSSI.** `mayTouchRecord` répond `true` sans contexte,
 * par conception (playground, workflow, test). On ne renverse pas ce fail-open — mais un
 * résolveur n'a aucune raison de rendre un UUID à un appelant dont on ignore l'identité.
 */
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
        return projectEmployee(employees[0]!, _ctx?.requestContext);
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

        return projectMember(member, _ctx?.requestContext);
      }

      if (members.length > 1) {
        return ambiguous(members.map((m) => label(m.firstName, m.lastName, m.title)));
      }

      return { found: false as const, reason: 'no_match' as const, hint: NO_MATCH_HINT };
    },
  });
}

/**
 * Les deux projections sont sorties d'`execute` le 2026-08-21 : la réduction de sortie l'avait
 * portée à une complexité cognitive de 18 (seuil 15), et une fonction qui décide À LA FOIS de la
 * résolution et de ce qui sort est exactement celle qu'on relit mal le jour où l'une des deux
 * doit bouger.
 */
function projectEmployee(
  found: {
    id: string;
    firstName: string;
    lastName: string;
    position: string | null;
    status: string;
  },
  requestContext: unknown,
) {
  const identified = mayHoldKeyFor(requestContext, found.id);

  return {
    found: true as const,
    source: 'employees' as const,
    employee: {
      ...(identified ? { id: found.id, status: found.status } : {}),
      firstName: sanitizeDisplayName(found.firstName),
      lastName: sanitizeDisplayName(found.lastName),
      position: found.position,
    },
    ...(identified ? {} : { hint: WITHHELD_HINT }),
  };
}

function projectMember(
  member: {
    slackUserId: string;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    employeeId: string | null;
  },
  requestContext: unknown,
) {
  const identified = mayHoldKeyFor(requestContext, member.employeeId);
  // Deux raisons distinctes de joindre un hint, et elles ne disent pas la même chose : « cette
  // personne n'a pas de dossier » n'est pas « tu n'as pas à tenir son identifiant ».
  let hint: string | undefined;
  if (!identified) hint = WITHHELD_HINT;
  else if (!member.employeeId) hint = DIRECTORY_ONLY_HINT;

  return {
    found: true as const,
    source: 'slack_directory' as const,
    person: {
      slackUserId: member.slackUserId,
      firstName: sanitizeDisplayName(member.firstName),
      lastName: sanitizeDisplayName(member.lastName),
      title: sanitizeDisplayName(member.title),
      ...(identified ? { employeeId: member.employeeId } : {}),
    },
    ...(hint ? { hint } : {}),
  };
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
