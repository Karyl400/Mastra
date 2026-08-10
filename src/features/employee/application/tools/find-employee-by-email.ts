import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';

/**
 * Résout un employé à partir de son email.
 *
 * Contexte (trace de production) : un utilisateur demandait « Récupère les informations
 * concernant Karyl SOUMAILA » ; l'agent n'avait aucun moyen de passer d'un nom/email à
 * un ID d'employé et redemandait en boucle un UUID à l'utilisateur — trou fonctionnel,
 * pas un problème de prompt. Ce tool lève l'ambiguïté d'identité ; l'agent enchaîne
 * ensuite avec `getEmployeeProfile(employeeId)` pour le détail complet si besoin.
 *
 * Sécurité — non négociable (voir audit) : n'importe quel membre du workspace Slack peut
 * déclencher ce tool. On n'expose donc QUE le strict nécessaire pour lever l'ambiguïté
 * d'identité : identifiant interne, prénom/nom, statut. Explicitement PAS exposés :
 * salaire, contact d'urgence, téléphone, métadonnées, ni même l'email en retour (déjà
 * connu de l'appelant). Le détail complet reste derrière `getEmployeeProfile`.
 *
 * `email` réutilise `emailSchema` (partagé, épinglé Zod 3.25.76) qui trim + lowercase
 * déjà l'entrée ; l'email est re-normalisé dans `execute` pour rester robuste même si
 * ce tool est appelé directement (tests, futurs appelants) sans passer par la validation
 * du schéma d'entrée.
 */
export function makeFindEmployeeByEmail(repo: EmployeeRepository) {
  return createTool({
    id: 'findEmployeeByEmail',
    description:
      "Retrouve l'identifiant interne d'un employé à partir de son email professionnel. " +
      "Renvoie found=false (jamais une exception) si l'email est inconnu.",
    inputSchema: z.object({
      email: emailSchema.describe("Email professionnel de l'employé à rechercher"),
    }),
    execute: async (data) => {
      const normalizedEmail = String(data.email).trim().toLowerCase();

      logger.info('Recherche employé par email', { email: normalizedEmail });

      const employee = await repo.findByEmail(normalizedEmail);

      if (!employee) {
        logger.info('Aucun employé trouvé pour cet email', { email: normalizedEmail });
        return { found: false as const };
      }

      return {
        found: true as const,
        employee: {
          id: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          status: employee.status,
        },
      };
    },
  });
}
