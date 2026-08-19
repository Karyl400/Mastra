import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import type { EmployeeRepository } from '../../../employee/domain/ports/employee.repository';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import { fullName, matchesName } from '../../../../shared/name-matching';
import { logger } from '../../../../shared/logger';
import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';

/**
 * « QUI PEUT FAIRE QUOI » — résout une COMPÉTENCE vers des personnes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le manque
 * ════════════════════════════════════════════════════════════════════════════
 * Le workspace sait déjà qui fait quoi : `slack_directory.title` porte le poste déclaré dans
 * Slack (40 lignes au 2026-08-14) et `employees.position` celui du dossier (2 lignes). Aucun
 * tool ne savait interroger ni l'un ni l'autre. « Qui s'occupe du backend ? » n'avait donc
 * qu'une seule réponse possible — celle que le modèle inventait, dans l'espace négatif que
 * `agentToolBoundary` a précisément été écrit pour éclairer.
 *
 * C'est le symétrique de `findPersonByName` : celui-là va du NOM vers la personne, celui-ci
 * de la COMPÉTENCE vers les personnes. Il en reprend les trois disciplines.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Trois choix, et ce qu'ils écartent
 * ════════════════════════════════════════════════════════════════════════════
 *
 * **1. Deux sources, comme `findPersonByName`.** Awa n'a AUCUNE ligne d'annuaire mais a une
 * ligne `employees` ; les quatre autres personnes vivantes sont dans le cas inverse. Une
 * source unique laisserait la moitié du workspace introuvable — le relevé de production
 * l'impose, ce n'est pas une précaution théorique.
 *
 * **2. AUCUN identifiant, AUCUNE adresse dans le résultat.** La discipline vient de
 * `findPersonByName`, et elle pèse plus lourd ici : la question est posée au PLURIEL, donc
 * une réponse portant des UUID inviterait le modèle à en choisir un — le geste exact qui a
 * envoyé le document d'Awa à l'adresse de Karyl. Sans identifiant, l'appel suivant est
 * structurellement impossible : le modèle doit nommer les personnes et laisser l'humain
 * choisir. Et c'est bien ce qu'on veut : « va voir Pamela » est la réponse utile.
 *
 * **3. Le poste DÉCLARÉ, et lui seul.** `onboarding_interview.dailyWork` — « je développe les
 * API paiement » — serait une matière bien plus riche. Elle est délibérément ABSENTE, pour
 * deux raisons dont la première suffit :
 *   - la table comptait **0 ligne** au 2026-08-14 : l'inclure n'ajouterait aujourd'hui aucune
 *     recall, seulement du code non exercé ;
 *   - une personne l'a écrite dans un entretien d'accueil dont l'objet annoncé est son guide
 *     et ses canaux. En faire un index interrogeable par ses collègues est un CHANGEMENT
 *     D'USAGE, qui se demande avant de se coder. `TODO.md` porte la question ouverte.
 * Un poste Slack, lui, est déjà visible de tout le workspace dans le profil de la personne :
 * l'exposer ici ne divulgue rien de neuf.
 *
 * ⚠️ Le rapprochement est celui de `matchesName` — préfixe de MOT, jamais sous-chaîne. C'est
 * la même règle que pour les noms et elle sert ici aussi bien : « postgres » retrouve
 * « PostgreSQL », « dev » retrouve « Developer », et « api » ne retrouve pas « rapide ».
 */

/**
 * Borne du résultat. Plus haute que les 5 de `findPersonByName` — une compétence est
 * légitimement partagée par plusieurs personnes, là où un nom en désigne une — mais bornée
 * quand même : le tool-result est réémis à CHAQUE aller-retour suivant, sa taille ne doit
 * donc dépendre ni du nombre de personnes ni de la taille du workspace.
 */
const MAX_EXPERTS = 6;

/**
 * Chaque étiquette est bornée, et pas seulement leur nombre.
 *
 * Mesuré : 8 personnes portant « Backend Developer Senior Platform » pèsent 153 tokens, alors
 * que le tool-result est réémis à chaque aller-retour suivant. Borner la LISTE sans borner ses
 * éléments laisse la taille dépendre de la longueur des intitulés — c'est exactement le défaut
 * qui a coûté 9 600 tokens à `getNotificationHistory` et 2 506 à `getEmployeeProfile`.
 */
const MAX_LABEL_CHARS = 44;

const NO_MATCH_HINT =
  'Personne ne le mentionne dans son poste déclaré. Dis-le, et n’invente aucun nom.';

/**
 * ⚠️ Les deux consignes ci-dessous existent parce que « personne ne correspond » et « je n'ai
 * pas pu chercher » n'ont RIEN à voir, et que cet outil les confondait. Une absence est
 * invérifiable pour qui la reçoit : c'est le type de réponse qu'il faut le plus se garder de
 * rendre à tort.
 */
const DIRECTORY_DOWN_HINT =
  'Tu n’as pas pu consulter l’annuaire : ne conclus PAS que personne ne fait ça. Dis que la ' +
  'recherche a échoué et propose de réessayer.';

const PARTIAL_SEARCH_HINT =
  'Une des deux sources était indisponible : la recherche est incomplète. Dis que tu n’as ' +
  'trouvé personne DANS CE QUE TU AS PU CONSULTER, sans en faire une certitude.';

/** Ce qu'une source rend : son résultat ET si elle a pu répondre. */
interface SourceResult {
  readonly available: boolean;
  readonly experts: Expert[];
}

export interface FindExpertiseDeps {
  readonly directoryRepo: DirectoryRepository;
  readonly employeeRepo: Pick<EmployeeRepository, 'findAll'>;
  /**
   * L'ENTRETIEN — « ce que tu fais au quotidien », écrit par la personne elle-même.
   *
   * ⚠️ Ajouté le 2026-08-19 sur un défaut mesuré en production : à « qui s'occupe du support
   * technique ? », l'outil a répondu « aucun collaborateur n'est identifié » alors que la
   * personne venait d'écrire, dans son entretien, qu'elle fait du support technique. La
   * réponse était HONNÊTE — la donnée était ailleurs — mais c'est le seul endroit du produit
   * où quelqu'un décrit son métier avec ses mots, donc exactement ce qu'une recherche
   * d'expertise cherche. `position` est un intitulé RH, saisi une fois ; l'entretien est ce
   * que la personne fait.
   *
   * OPTIONNEL à dessein : sans lui, l'outil se comporte exactement comme avant, et son
   * absence n'est PAS comptée comme une source en panne — ce serait transformer une
   * configuration en incident.
   */
  readonly interviewRepo?: Pick<OnboardingInterviewRepository, 'listAll'>;
}

interface Expert {
  /** Clé de déduplication : le nom normalisé, seule donnée commune aux deux sources. */
  readonly key: string;
  readonly label: string;
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

      // L'annuaire d'abord : son `title` est tenu par la personne elle-même dans Slack, donc
      // plus à jour que `employees.position`, saisi une fois à la création du dossier.
      const experts = dedupe([...fromDirectory.experts, ...fromEmployees.experts]);

      if (experts.length === 0) {
        // ⚠️ « PERSONNE NE CORRESPOND » ET « JE N'AI PAS PU CHERCHER » NE SONT PAS LA MÊME
        // CHOSE, et c'était le seul échec réellement silencieux du lot d'outils. Les deux
        // `catch` rendaient `[]` : une panne d'annuaire devenait « personne ne sait faire
        // ça », que l'agent restituait comme un FAIT — indiscernable d'un vrai `no_match`.
        //
        // Tous les autres outils du dépôt nomment leur cause dans `reason` ; celui-ci ne le
        // faisait pas, et c'est précisément le genre de réponse qu'on ne peut pas contredire :
        // l'absence est invérifiable pour qui la reçoit.
        const bothDown = !fromDirectory.available && !fromEmployees.available;
        if (bothDown) {
          return {
            found: false,
            reason: 'directory_unavailable',
            hint: DIRECTORY_DOWN_HINT,
          };
        }

        // Une seule source en panne : on a cherché pour de bon, mais pas partout. On le dit,
        // sans transformer une recherche partielle en absence certaine.
        const partial = !fromDirectory.available || !fromEmployees.available;
        return {
          found: false,
          reason: partial ? 'partial_search' : 'no_match',
          hint: partial ? PARTIAL_SEARCH_HINT : NO_MATCH_HINT,
        };
      }

      return {
        found: true,
        people: experts.slice(0, MAX_EXPERTS).map((expert) => truncate(expert.label)),
        truncated: experts.length > MAX_EXPERTS,
      };
    },
  });
}

/**
 * ⚠️ Ne LÈVE jamais — discipline commune à tous les résolveurs du dépôt. Une source en panne
 * doit dégrader la recall, pas faire échouer la question : l'autre source répond peut-être.
 */
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
      // Le POSTE d'abord : c'est l'intitulé officiel, et c'est ce qu'on préfère montrer.
      // L'entretien ne sert de matière que s'il apporte quelque chose que le poste ne dit pas.
      const daily = dailyWork.get(employee.id) ?? '';
      const matchedPosition = Boolean(employee.position) && matchesName(skill, [employee.position]);
      const matchedDaily = Boolean(daily) && matchesName(skill, [daily]);
      if (!matchedPosition && !matchedDaily) continue;

      const evidence = matchedPosition ? employee.position : daily;
      experts.push({ key: normalizeKey(name), label: `${safePart(name)} — ${safePart(evidence)}` });
    }

    return { available: true, experts };
  } catch (error) {
    logger.warn('findExpertise: dossiers indisponibles', { error: String(error) });
    return { available: false, experts: [] };
  }
}

/**
 * Ce que chacun a dit faire au quotidien, par identifiant d'employé.
 *
 * ⚠️ Un échec est AVALÉ et rend une table vide : l'entretien est une matière SUPPLÉMENTAIRE.
 * Le faire remonter en `available: false` transformerait « la table des entretiens est
 * indisponible » en « la recherche est incomplète », alors que la source principale a
 * parfaitement répondu — on rendrait la réponse moins sûre qu'elle ne l'est.
 */
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

/**
 * Une personne présente dans les DEUX sources est UNE personne. Sans cela, Awa — qui a un
 * dossier et pourrait gagner une ligne d'annuaire demain — apparaîtrait deux fois, et deux
 * lignes se lisent comme deux collègues disponibles.
 */
function dedupe(experts: readonly Expert[]): Expert[] {
  const seen = new Set<string>();
  return experts.filter((expert) => {
    if (expert.key.length === 0 || seen.has(expert.key)) return false;
    seen.add(expert.key);
    return true;
  });
}

/** `realName` d'abord : `displayName` est vide sur une bonne part des lignes réelles. */
function displayNameOf(realName: string, displayName: string): string {
  return realName.trim() || displayName.trim();
}

/** Le NOM doit survivre à la coupe : c'est lui qui rend la réponse actionnable, pas l'intitulé. */
/**
 * ⚠️ ON ASSAINIT AVANT DE TRONQUER, et l'ordre importe.
 *
 * Ce libellé est bâti sur `title` (poste DÉCLARATIF, édité par son porteur — `schema.ts`) et
 * sur `dailyWork` (prose libre écrite dans l'entretien). Deux champs contrôlés par des tiers,
 * restitués en réponse à la question d'un AUTRE.
 *
 * ⚠️ LA TRONCATURE N'EST PAS UNE PROTECTION, et l'avoir cru a produit un test vert sur du code
 * vulnérable : `MAX_LABEL_CHARS = 44` coupait une charge LONGUE avant son délimiteur, donc le
 * premier test écrit passait. Une charge courte — `backend <kisso_x>` — traversait
 * intégralement. Une borne ne protège que de ce qui est plus long qu'elle.
 *
 * Liste blanche (lettres, marques, chiffres, `.'’-`) plutôt que bannière : cet agent est déjà
 * en quarantaine de sortie, la bannière coûterait des tokens sur un libellé de 44 caractères,
 * et un poste ou un fragment de métier en ressort lisible.
 *
 * ⚠️ ON ASSAINIT LES PARTIES, JAMAIS LE LIBELLÉ ASSEMBLÉ. Le séparateur « — » du gabarit
 * n'est pas dans la liste blanche : le passer entier détruirait la structure « nom — indice »,
 * qui est ce qui rend la réponse lisible. Le séparateur vient de NOTRE code, il n'a pas à être
 * assaini ; ce sont `title` et `dailyWork` qui viennent d'ailleurs. Essayé dans l'autre sens
 * le 2026-08-19 : « Pamela KONE — je fais du support, niveau 2 (API) » ressortait en
 * « Pamela KONE je fais du support niveau 2 API ».
 */
function safePart(raw: string | null | undefined): string {
  return sanitizeDisplayName(raw);
}

function truncate(label: string): string {
  return label.length <= MAX_LABEL_CHARS ? label : `${label.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function normalizeKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
