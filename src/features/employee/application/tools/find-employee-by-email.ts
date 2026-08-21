import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import { emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { mayHoldKeyFor, readSlackContext } from '../../../../shared/slack-request-context';

const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu', 'localhost'];
const RESERVED_TLDS = ['.test', '.example', '.invalid', '.localhost', '.local'];

const PLACEHOLDER_LOCAL_PARTS = new Set([
  'votreemail',
  'youremail',
  'email',
  'mail',
  'adresse',
  'user',
  'utilisateur',
  'username',
  'name',
  'nom',
  'prenom',
  'nomprenom',
  'prenomnom',
  'firstnamelastname',
  'johndoe',
  'janedoe',
  'exemple',
  'example',
  'test',
  'placeholder',
]);

function isPlaceholderEmail(email: string): boolean {
  const separator = email.lastIndexOf('@');
  if (separator === -1) return false;

  const localPart = email.slice(0, separator);
  const domain = email.slice(separator + 1);

  if (RESERVED_DOMAINS.includes(domain)) return true;
  if (RESERVED_TLDS.some((tld) => domain.endsWith(tld))) return true;

  return PLACEHOLDER_LOCAL_PARTS.has(localPart.replace(/[._-]/g, ''));
}

export function makeFindEmployeeByEmail(repo: EmployeeRepository, directory?: DirectoryRepository) {
  return createTool({
    id: 'findEmployeeByEmail',
    description:
      "Retrouve une personne par son email : son dossier d'onboarding si elle en a un, " +
      "sinon l'annuaire Slack. Renvoie found=false (jamais une exception) si l'email est inconnu.",
    inputSchema: z.object({
      email: emailSchema.describe("Email de l'employé à rechercher"),
    }),
    execute: async (data, ctx) => {
      const normalizedEmail = String(data.email).trim().toLowerCase();

      if (isPlaceholderEmail(normalizedEmail)) {
        logger.warn('Email de remplissage refusé — valeur probablement inventée par le modèle', {
          localPart: normalizedEmail.slice(0, normalizedEmail.lastIndexOf('@')),
          domain: normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1),
        });

        return {
          found: false as const,
          reason: 'placeholder_email' as const,
          hint:
            "Cette adresse est un exemple générique, pas celle d'un employé. " +
            "Ne l'invente pas : demande à l'utilisateur son email réel.",
        };
      }

      logger.info('Recherche employé par email', { email: normalizedEmail });

      const employee = await repo.findByEmail(normalizedEmail);
      /**
       * On ne consulte l'annuaire que si le dossier n'a rien donné : c'est un aller-retour, et
       * ce dépôt les compte. Écrit en deux temps plutôt qu'en ternaire imbriqué — la forme
       * condensée cachait l'ORDRE, qui est précisément ce qui compte ici.
       */
      let memberEarly: Awaited<ReturnType<NonNullable<typeof directory>['findByEmail']>> = null;
      if (!employee && directory) memberEarly = await directory.findByEmail(normalizedEmail);

      /**
       * ⚠️ **ANTI-ORACLE — le verdict est le MÊME que l'adresse désigne quelqu'un ou personne.**
       *
       * Sans cela, ce tool répond `found: true/false` sur une adresse arbitraire, à n'importe
       * qui : c'est l'énumération de l'annuaire une adresse à la fois. `getEmployeeProfile` a
       * été retravaillé pour ne pas être cet oracle — « il passe l'identifiant RÉSOLU **ou
       * `null`** » — et la même précaution n'avait pas été portée ici.
       *
       * ⚠️ **On résout D'ABORD, on décide ENSUITE.** L'ordre inverse (refuser avant de lire)
       * serait plus économe mais rouvrirait l'oracle : il faut connaître la cible pour savoir
       * si le demandeur y a droit, et c'est précisément pour cela que le refus ne peut pas
       * tomber avant la lecture sur CE chemin — contrairement au chemin par identifiant, où il
       * le peut et où il le fait.
       */
      const resolvedId = employee?.id ?? memberEarly?.employeeId ?? null;
      if (!mayHoldKeyFor(ctx?.requestContext, resolvedId)) {
        logger.info('Résolution par email refusée — verdict neutre', {
          authorised: false,
        });
        return unresolvable(readSlackContext(ctx?.requestContext)?.employeeId);
      }

      if (employee) {
        return {
          found: true as const,
          source: 'employees' as const,
          employee: {
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            status: employee.status,
          },
        };
      }

      const member = memberEarly;

      if (member && !member.isBot && !member.isDeleted) {
        logger.info("Employé absent de la base, résolu par l'annuaire Slack", {
          slackUserId: member.slackUserId,
          linked: Boolean(member.employeeId),
        });

        return {
          found: true as const,
          source: 'slack_directory' as const,
          person: {
            slackUserId: member.slackUserId,
            firstName: member.firstName,
            lastName: member.lastName,
            title: member.title,
            employeeId: member.employeeId,
          },
          hint: member.employeeId
            ? undefined
            : "Cette personne est dans Slack mais n'a aucun dossier d'onboarding : " +
              'getEmployeeProfile et les rappels ne fonctionneront pas pour elle. ' +
              "N'invente aucun identifiant interne ; dis-le simplement.",
        };
      }

      logger.info('Aucun employé trouvé pour cet email', { email: normalizedEmail });

      const requesterEmployeeId = readSlackContext(ctx?.requestContext)?.employeeId;

      return {
        found: false as const,
        ...(requesterEmployeeId
          ? {
              hint:
                'Aucun dossier à cette adresse — et ne la réessaie pas en la modifiant. Si la ' +
                `demande concerne la personne qui te parle, son identifiant interne est ` +
                `${requesterEmployeeId} : utilise-le directement, ne lui redemande pas son email.`,
            }
          : {}),
      };
    },
  });
}

/**
 * Le verdict rendu quand le demandeur n'a pas à tenir cet identifiant.
 *
 * ⚠️ **Il n'affirme PAS que l'adresse ne désigne personne** — ce serait un mensonge dans la
 * moitié des cas, et ce dépôt ne fabrique pas de faux négatifs pour se protéger. Il dit
 * seulement qu'il ne peut pas résoudre, ce qui est exactement vrai : la résolution est refusée.
 *
 * ⚠️ Il porte le MÊME `hint` d'auto-résolution que le vrai « non trouvé », sans quoi la
 * différence de forme rouvrirait l'oracle qu'on vient de fermer.
 */
function unresolvable(requesterEmployeeId: string | undefined) {
  return {
    found: false as const,
    reason: 'not_resolvable' as const,
    ...(requesterEmployeeId
      ? {
          hint:
            'Je ne peux pas résoudre cette adresse — et ne la réessaie pas en la modifiant. ' +
            'Si la demande concerne la personne qui te parle, son identifiant interne est ' +
            `${requesterEmployeeId} : utilise-le directement, ne lui redemande pas son email. ` +
            'Sinon, dis simplement que tu ne peux pas.',
        }
      : {}),
  };
}
