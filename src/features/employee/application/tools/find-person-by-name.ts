import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import { logger } from '../../../../shared/logger';
import { fullName } from '../../../../shared/name-matching';
import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';

/**
 * Résout une personne par son NOM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut, mesuré sur la Turso de production le 2026-08-13
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   employee_id=d20df236…(Karyl)  type=welcome_letter  title="Bienvenue Awa"  status=sent
 *
 * Les DIX documents de la base portent l'UUID de Karyl — y compris celui intitulé
 * « Bienvenue Awa », dont l'email est donc parti à l'adresse de Karyl. Awa a pourtant sa
 * propre ligne `employees` ; elle est simplement absente de `slack_directory`, si bien que
 * `findEmployeeByEmail` — seul résolveur existant — exigeait une adresse que personne
 * n'avait tapée.
 *
 * Sommé de fournir un `employeeId` par le schéma de `generateDocument`, le modèle a fait ce
 * que ce dépôt sait qu'il fait devant un espace vide : il a réutilisé le seul UUID présent
 * dans son contexte. Même mécanique que l'email `votre_email@example.com` documenté dans
 * `find-employee-by-email.ts` — **le modèle produit une valeur valide pour que l'appel
 * passe**, et aucune validation Zod ne peut le voir.
 *
 * `TODO.md` recensait ce manque depuis le 2026-08-12 (« Aucun tool ne résout un PRÉNOM »)
 * sans l'avoir relié au bug de destinataire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Deux sources, `employees` d'abord — et c'est le relevé qui l'impose
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Au 2026-08-14 : `employees` = 2 lignes (Karyl, Awa) ; `slack_directory` = 40 lignes dont
 * 4 personnes vivantes non rattachées (Nazer, Pamela, Mistourath, ridwanenico77) — et Awa
 * n'y figure pas. **Une seule des deux sources laisserait la moitié du workspace
 * irrésolvable.**
 *
 * L'ordre est celui de `findEmployeeByEmail`, pour la même raison : `employees` porte
 * l'UUID interne dont dépendent `getEmployeeProfile`, `generateDocument` et
 * `scheduleReminder`. L'inverse ferait perdre cet identifiant pour un employé enregistré.
 */

/**
 * Nombre maximal de candidats rendus sur une ambiguïté.
 *
 * Ce résultat entre dans l'historique et est réémis à chaque aller-retour suivant, sur un
 * budget de ≈ 19 messages par jour. Cinq noms suffisent à ce qu'un humain reconnaisse le
 * sien ; au-delà, la bonne réponse est « précise ta demande », pas une liste plus longue.
 */
export const MAX_NAME_CANDIDATES = 5;

/**
 * Longueur minimale de la requête.
 *
 * Une seule lettre correspondrait, par la règle de préfixe, à une grande partie du
 * workspace : l'ambiguïté rendue porterait alors sur tout le monde, ce qui n'apprend rien
 * et coûte des tokens. Deux caractères est le plancher où la question reste une question.
 */
const MIN_NAME_LENGTH = 2;

const NO_MATCH_HINT =
  "Ce nom ne correspond à personne, ni parmi les employés enregistrés ni dans l'annuaire " +
  "Slack. N'invente ni identifiant ni adresse : demande l'email de la " +
  'personne, ou son orthographe exacte.';

/**
 * Consigne rendue sur ambiguïté.
 *
 * ⚠️ Elle accompagne une liste de candidats SANS AUCUN IDENTIFIANT — voir plus bas. C'est
 * elle qui transforme le silence en question posée à l'humain.
 */
const AMBIGUOUS_HINT =
  'Plusieurs personnes portent ce nom. Ne choisis pas : demande laquelle, en citant ces noms.';

/**
 * Consigne rendue quand la personne n'existe que dans l'annuaire Slack.
 *
 * Reprise mot pour mot de `findEmployeeByEmail` : les deux tools doivent instruire le
 * modèle de la même façon, sans quoi le même état de fait produirait deux comportements.
 */
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

      // On demande UN candidat de plus que la borne : c'est ce qui permet de dire
      // `truncated` sans un second aller-retour, et sans le déduire d'une égalité qui
      // serait fausse quand le total vaut exactement la borne.
      const employees = await repo.findByName(query, MAX_NAME_CANDIDATES + 1);

      if (employees.length === 1) {
        const found = employees[0]!;
        return {
          found: true as const,
          source: 'employees' as const,
          employee: {
            id: found.id,
            // Même traitement que la branche annuaire : ces champs viennent d'un dossier
            // que la personne a elle-même rempli en conversation.
            firstName: sanitizeDisplayName(found.firstName),
            lastName: sanitizeDisplayName(found.lastName),
            position: found.position,
            status: found.status,
            // ⚠️ PAS d'email. Ce tool lève une ambiguïté d'identité, il n'est pas un canal
            // de sortie de données personnelles — et il est atteignable par n'importe quel
            // membre du workspace. Même arbitrage que `findEmployeeByEmail`.
          },
        };
      }

      if (employees.length > 1) {
        return ambiguous(employees.map((e) => label(e.firstName, e.lastName, e.position)));
      }

      // Repli sur l'annuaire. Bots et comptes désactivés écartés : ce ne sont pas des
      // personnes à onboarder, et les rendre inviterait le modèle à leur proposer un
      // document. Le workspace de production porte 22 bots sur 40 lignes.
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
            // Nom de clé distinct d'`employee` À DESSEIN, comme dans `findEmployeeByEmail` :
            // cette personne n'a pas de dossier. Réutiliser `employee.id` ferait passer un
            // `U…` pour l'UUID interne qu'attendent les autres tools.
            slackUserId: member.slackUserId,
            // ⚠️ TEXTE ÉCRIT PAR UN TIERS. `schema.ts` le dit : « `title` est le poste
            // DÉCLARATIF, ÉDITÉ PAR SON PORTEUR » — donc par n'importe qui du workspace,
            // invité mono-canal compris, sans revue, et restitué ici en réponse à la question
            // D'UN AUTRE. Cet outil est câblé sur `notificationAgent`, qui porte
            // `sendNotification` : c'est la conjonction lecture-de-tiers + écriture externe
            // qu'`outbound-tool-quarantine.ts` §4.2 interdit, atteinte par la porte que
            // personne ne gardait. `findExpertise`, lui, est protégé en aval par la
            // quarantaine ; celui-ci ne l'est pas.
            //
            // On réutilise le neutraliseur du préambule d'identité plutôt qu'une bannière :
            // c'est une LISTE BLANCHE (lettres, marques, chiffres, `.'’-`), donc ni chevron,
            // ni deux-points, ni retour à la ligne, ni URL ne survivent — et un poste
            // ordinaire en ressort intact. Coût en tokens : négatif, il raccourcit.
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

/**
 * Un candidat, en UNE chaîne plutôt qu'en objet à trois clés.
 *
 * Les noms de clés (`firstName`, `lastName`, `role`) seraient répétés à chaque candidat —
 * 25 caractères × 5, soit ≈ 36 tokens de pure structure, réémis à chaque aller-retour
 * suivant. Or cette liste n'est pas destinée à être destructurée : elle est destinée à
 * être RÉCITÉE à un humain pour qu'il désigne la bonne personne.
 */
function label(firstName: string | null, lastName: string | null, role: string | null): string {
  // ⚠️ Ce libellé sort AUSSI vers le modèle, sur le chemin ambigu. L'oublier aurait laissé
  // ouverte exactement la même porte, une branche plus loin.
  [firstName, lastName, role] = [
    sanitizeDisplayName(firstName),
    sanitizeDisplayName(lastName),
    sanitizeDisplayName(role),
  ];
  // Le repli « (sans nom) » reste ICI : c'est une décision d'affichage propre à la levée
  // d'ambiguïté, et un document signé ne doit surtout pas l'imprimer.
  const name = fullName(firstName, lastName) || '(sans nom)';
  return role ? `${name} — ${role}` : name;
}

/**
 * Résultat d'ambiguïté — **sans aucun identifiant**, et c'est la garantie centrale du tool.
 *
 * Rendre deux UUID reviendrait à laisser le modèle en choisir un : c'est très exactement le
 * geste qui a enregistré « Bienvenue Awa » sous l'identifiant de Karyl et envoyé le fichier
 * à son adresse. Sans identifiant, l'appel suivant est structurellement impossible — le
 * modèle n'a plus d'autre issue que de poser la question, ce que `AMBIGUOUS_HINT` lui dit
 * de faire.
 *
 * Le discriminant rendu est le RÔLE, jamais l'email : c'est ce qui distingue deux homonymes
 * aux yeux d'un collègue, et ça ne divulgue rien qu'un annuaire d'entreprise ne montre.
 */
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
