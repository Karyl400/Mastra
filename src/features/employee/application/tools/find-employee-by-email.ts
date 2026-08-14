import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import { emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { readSlackContext } from '../../../../shared/slack-request-context';

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

/**
 * Deuxième source de résolution : l'ANNUAIRE SLACK (`slack_directory`).
 *
 * Constat de production du 2026-08-12 — c'est la panne que le propriétaire décrit par
 * « il ne retrouve pas les autres profils à part le mien ». La table `employees` n'est
 * peuplée que par la modale « Compléter mon profil », déclenchée par le seul événement
 * `team_join` : elle contenait **une ligne vivante** pour un workspace de 6 personnes.
 * Les deux emails déclarés introuvables ce soir-là (`ridwanenico77@gmail.com`,
 * `mistourath@kissohq.com`) étaient présents dans `slack_directory`, avec prénom, nom et
 * poste. La donnée était là ; aucun tool ne la lisait.
 *
 * L'annuaire est un MIROIR de Slack, `employees` une donnée PROPRE au produit. D'où
 * l'ordre : `employees` d'abord — c'est lui qui porte l'UUID interne dont dépendent
 * `getEmployeeProfile`, `generateDocument` et `scheduleReminder` — puis l'annuaire en repli.
 * L'inverse ferait perdre l'identifiant interne d'un employé enregistré.
 *
 * ⚠️ Dépendance OPTIONNELLE : le tool reste appelable sans annuaire (tests, playground,
 * base neuve). Sans lui, le comportement est exactement celui d'avant.
 */
export function makeFindEmployeeByEmail(repo: EmployeeRepository, directory?: DirectoryRepository) {
  return createTool({
    id: 'findEmployeeByEmail',
    description:
      "Retrouve une personne par son email : son dossier d'onboarding si elle en a un, " +
      "sinon l'annuaire Slack. Renvoie found=false (jamais une exception) si l'email est inconnu.",
    inputSchema: z.object({
      email: emailSchema.describe("Email professionnel de l'employé à rechercher"),
    }),
    execute: async (data, ctx) => {
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

      // Repli sur l'annuaire Slack. Bots et comptes désactivés sont écartés : ce ne
      // sont pas des personnes à onboarder, et les rendre inviterait le modèle à
      // proposer de leur envoyer un document.
      const member = directory ? await directory.findByEmail(normalizedEmail) : null;

      if (member && !member.isBot && !member.isDeleted) {
        logger.info("Employé absent de la base, résolu par l'annuaire Slack", {
          slackUserId: member.slackUserId,
          linked: Boolean(member.employeeId),
        });

        // `employeeId` est le pont posé par `directorySync` quand l'email Slack
        // correspond déjà à une ligne `employees`. Il est `null` pour quelqu'un qui
        // n'a jamais rempli le formulaire de profil — le cas de 5 personnes sur 6.
        return {
          found: true as const,
          source: 'slack_directory' as const,
          person: {
            // Nom de clé distinct d'`employee` À DESSEIN : cette personne n'a pas
            // de dossier d'onboarding. Réutiliser `employee.id` ferait passer un
            // `U…` pour l'UUID interne qu'attendent les autres tools.
            slackUserId: member.slackUserId,
            firstName: member.firstName,
            lastName: member.lastName,
            // `profile.title` — le poste DÉCLARÉ dans Slack, pas le poste contractuel.
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

      // ────────────────────────────────────────────────────────────────────────
      // ÉCHEC QUI INSTRUIT — un aller-retour épargné vaut plus que tout dégraissage
      // ────────────────────────────────────────────────────────────────────────
      // `return { found: false }` était NU, et le relevé de production montre exactement ce
      // que ça coûte. Deux fois, sur deux jours :
      //
      //     Karyl  : « Bonjour, que peux-tu faire pour moi ? »
      //     Mastra : « Je n'ai pas trouvé d'employé avec l'adresse
      //               karyl.soumaila@kisso.com. […] Tu peux me les donner ? »
      //
      // Deux défauts en une réponse. Le modèle a FABRIQUÉ une adresse plausible à partir du
      // nom de la personne — `isPlaceholderEmail` ne peut rien contre elle, elle est bien
      // formée et son domaine est réel. Puis il a réclamé à l'humain une information que le
      // système DÉTENAIT DÉJÀ : l'identité du demandeur descend par le `requestContext`.
      //
      // Le tour de dialogue ainsi provoqué est le poste de coût le plus cher du produit —
      // la doctrine du dépôt le dit : « un tour de dialogue épargné vaut plus que plusieurs
      // centaines de tokens rabotés », sur un budget de ≈ 19 messages/JOUR.
      //
      // ⚠️ Aucune donnée nouvelle n'est exposée : c'est l'identifiant du DEMANDEUR lui-même,
      // que `canReadPersonRecord` l'autorise déjà à lire (« son propre dossier toujours »),
      // et il vient du contexte serveur — jamais d'une valeur écrite par un attaquant.
      // Payé uniquement dans cette branche, comme les autres `hint` du dépôt.
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
