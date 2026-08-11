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
/**
 * Domaines réservés par la RFC 2606 (et voisins), qui ne désignent JAMAIS une
 * boîte réelle. `example.*` en second niveau, le reste en suffixe de TLD.
 */
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu', 'localhost'];
const RESERVED_TLDS = ['.test', '.example', '.invalid', '.localhost', '.local'];

/**
 * Parties locales de remplissage, sous forme NORMALISÉE (séparateurs `.`, `_` et
 * `-` retirés) : `votre_email`, `votre.email` et `votre-email` se ramènent au même
 * `votreemail`, sans avoir à énumérer les variantes.
 *
 * Comparaison EXACTE, jamais par sous-chaîne : `email` en sous-chaîne
 * condamnerait un `remaild@…` légitime, et le coût d'un faux positif est élevé —
 * c'est un employé réel que l'agent déclarerait introuvable.
 */
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

/**
 * L'email est-il un exemple générique plutôt qu'une vraie adresse ?
 *
 * Mécanisme visé, mesuré en production le 2026-08-11 : privé de mémoire
 * conversationnelle, le modèle n'a plus l'email donné au tour précédent, mais
 * `emailSchema` exige une adresse syntaxiquement valide — alors il en FABRIQUE
 * une (`votre_email@example.com`) pour que l'appel passe la validation. Zod ne
 * peut rien y voir : la valeur inventée est parfaitement bien formée. C'est le
 * même défaut que celui documenté dans `src/mastra/index.ts` à propos de
 * `createEmployee` (« le modèle substitue une valeur valide AVANT d'appeler
 * l'outil pour que l'appel réussisse »).
 *
 * Le contrôle vit ICI, et non dans `emailSchema` : ce schéma partagé sert aussi à
 * la création d'employés et aux entités, où élargir la liste des domaines
 * bloqués changerait le comportement de tout le dépôt pour un défaut propre à un
 * seul chemin — celui d'un LLM qui devine une entrée.
 */
function isPlaceholderEmail(email: string): boolean {
  const separator = email.lastIndexOf('@');
  if (separator === -1) return false;

  const localPart = email.slice(0, separator);
  const domain = email.slice(separator + 1);

  if (RESERVED_DOMAINS.includes(domain)) return true;
  if (RESERVED_TLDS.some((tld) => domain.endsWith(tld))) return true;

  return PLACEHOLDER_LOCAL_PARTS.has(localPart.replace(/[._-]/g, ''));
}

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

      // Avant toute E/S : une adresse d'exemple ne peut rien trouver en base, et
      // la laisser passer produirait un « aucun employé avec cet email » que le
      // modèle rapporterait à l'utilisateur comme un fait — exactement le
      // « Je ne trouve pas d'employé avec l'email votre_email@example.com »
      // observé le 2026-08-11 à 2:56.
      if (isPlaceholderEmail(normalizedEmail)) {
        // `warn` volontaire : une adresse de remplissage signale que le modèle a
        // inventé un paramètre. C'est la ligne à chercher quand un agent affirme
        // qu'un employé est introuvable.
        //
        // Partie locale et domaine sont journalisés SÉPARÉMENT, et non sous une
        // clé `email` : le logger masque le PII à la fois par nom de clé
        // (`isPiiKey`) et par forme de la valeur (`isPiiValue`), donc une adresse
        // entière ressortirait en `[REDACTED:EMAIL]` — ce qui viderait la ligne
        // de tout intérêt, alors qu'on cherche précisément à savoir QUELLE
        // adresse le modèle a fabriquée. Aucun secret n'est exposé : cette
        // branche n'est atteinte que par des adresses qui ne désignent personne.
        logger.warn('Email de remplissage refusé — valeur probablement inventée par le modèle', {
          localPart: normalizedEmail.slice(0, normalizedEmail.lastIndexOf('@')),
          domain: normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1),
        });

        // Résultat structuré, pas d'exception : le tool contracte explicitement
        // « jamais une exception » (cf. sa description), et les autres tools ne
        // lèvent (`NotFoundError`) que sur un identifiant censé exister —
        // `updateOnboardingStatus`, `evaluateResponse`, `sendNotification`. Ici
        // rien n'a été demandé de valide, et surtout : une exception remonterait
        // au catch générique du handler Slack, qui poste « Désolé, une erreur
        // s'est produite » — le modèle n'apprendrait rien et ne corrigerait pas.
        // `reason` + `hint` l'INSTRUISENT au contraire de la marche à suivre.
        return {
          found: false as const,
          reason: 'placeholder_email' as const,
          hint:
            "Cette adresse est un exemple générique, pas celle d'un employé. " +
            "Ne l'invente pas : demande à l'utilisateur son email professionnel réel.",
        };
      }

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
