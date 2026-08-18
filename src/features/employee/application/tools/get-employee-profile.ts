import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { Employee } from '../../domain/entities/employee';
import type { OnboardingRepository } from '../../../onboarding/domain/ports/onboarding.repository';
import type { OnboardingProgress } from '../../../onboarding/domain/entities/onboarding-progress';
import { uuidSchema, emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { canReadPersonRecord } from '../../../../shared/slack-request-context';
import { ONBOARDING_TOTAL_STEPS } from '../../../onboarding/domain/services/onboarding-plan';

/**
 * Consigne rendue au modèle quand l'identifiant ne désigne personne.
 *
 * Le tool levait `NotFoundError` ici. Or l'AI SDK v7 convertit ce que lève un
 * tool en part `tool-error` RÉINJECTÉE au modèle — le catch générique du
 * handler Slack n'est jamais atteint. Face à un vide, le modèle comble : c'est
 * ainsi qu'est né l'over-promise « as-tu besoin que je crée un profil ? », pour
 * une capacité qu'aucun agent ne possède. Un résultat qui INSTRUIT vaut mieux
 * qu'une exception ; même motif que `find-employee-by-email.ts`.
 */
const NOT_FOUND_HINT =
  "Aucun employé ne porte cet identifiant. Ne l'invente pas et n'en déduis rien : demande " +
  "l'email professionnel et passe par findEmployeeByEmail.";

/**
 * Consigne rendue quand l'employé existe mais n'a pas de suivi d'intégration.
 *
 * État réel des deux employés de production au 2026-08-11 : créés par le tool
 * `createEmployee` (un simple `repo.save`), ils n'avaient pas d'
 * `onboarding_progress`. Un `progress: null` nu se lisait comme « il n'y a plus
 * qu'à le créer » — d'où la proposition de création. Le rattrapage appartient
 * aux RH, pas au modèle.
 */
const NO_PROGRESS_HINT =
  "Suivi d'intégration non initialisé pour cet employé. Tu n'as aucun outil pour le créer : " +
  'signale-le, ne propose pas de le créer.';

/**
 * Consigne rendue quand le demandeur n'a pas le droit de lire CE dossier.
 *
 * Elle nomme la RÈGLE et jamais la donnée : elle ne dit pas si l'identifiant désigne
 * quelqu'un, ni ce que contient le dossier. Sans cela, le refus lui-même deviendrait un
 * oracle — « cet UUID existe » est déjà une information sur une personne.
 *
 * ⚠️ Elle INTERDIT explicitement de reformuler ou de réessayer. Sans cette phrase, un modèle
 * sommé de livrer un profil traite un refus comme un obstacle à contourner : c'est ce
 * comportement exact qui a produit 38 `findEmployeeByEmail` en 1,5 seconde le 2026-08-12.
 */
const NOT_AUTHORIZED_HINT =
  "Tu n'as pas accès au dossier de cette personne. Dis-le simplement, sans détour et sans " +
  'inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la demande.';

/**
 * Consigne rendue quand le modèle appelle le tool sans aucune clé.
 *
 * Les deux champs sont optionnels — il faut donc l'un OU l'autre, ce qu'un schéma Zod ne peut
 * pas exprimer ici (`z.discriminatedUnion` casse le parseur du Vercel AI SDK sous Zod 3.25.76).
 * La contrainte est donc vérifiée à l'exécution, et son non-respect INSTRUIT plutôt qu'il ne
 * lève : une exception repart au modèle en part `tool-error`, et un modèle privé de résultat
 * comble le vide.
 */
const MISSING_IDENTIFIER_HINT =
  "Précise QUI : soit l'email professionnel, soit l'identifiant de l'employé. N'en invente " +
  'aucun — si tu ne les as pas, demande-les.';

export function makeGetEmployeeProfile(
  empRepo: EmployeeRepository,
  onboardingRepo: OnboardingRepository,
) {
  return createTool({
    id: 'getEmployeeProfile',
    description: "Récupère le profil d un employé et l'avancement de son intégration",
    inputSchema: z.object({
      employeeId: uuidSchema.optional().describe('ID de l employé'),
      email: emailSchema
        .optional()
        .describe("Email pro — alternative à employeeId, évite de résoudre la personne d'abord"),
    }),
    execute: async (data, _ctx) => {
      // ════════════════════════════════════════════════════════════════════════
      // DEUX CLÉS D'ENTRÉE, et c'est une mesure de COÛT
      // ════════════════════════════════════════════════════════════════════════
      // Mesuré en production le 2026-08-15 : « profil de l'employé dont l'email est X »
      // coûtait TROIS étapes — `findEmployeeByEmail`, puis `getEmployeeProfile`, puis la
      // réponse — pour 4 711 tokens d'entrée. L'entrée est CUMULATIVE (1 417 + 1 559 + 1 735) :
      // chaque étape réémet tout le contexte. Une étape épargnée vaut donc ≈ 1 500 tokens,
      // près d'un tiers du message, là où raboter le prompt en rend quelques dizaines.
      //
      // ⚠️ `z.object` avec deux champs OPTIONNELS, jamais `z.discriminatedUnion` : Zod est
      // épinglé à 3.25.76 et le parseur de schémas du Vercel AI SDK casse sur cette
      // construction (piège documenté).
      const email = data.email ? String(data.email).trim().toLowerCase() : undefined;

      if (!data.employeeId && !email) {
        // On INSTRUIT, on ne lève pas : une exception repart au modèle en part `tool-error`,
        // et un modèle privé de résultat comble le vide.
        return {
          found: false as const,
          reason: 'missing_identifier' as const,
          hint: MISSING_IDENTIFIER_HINT,
        };
      }

      // ── Chemin EMAIL ──────────────────────────────────────────────────────
      // La résolution doit précéder la décision d'accès : on ne connaît pas encore la
      // personne visée. Le risque est d'en faire un ORACLE d'existence — `not_authorized`
      // signifierait « cette adresse existe », `employee_not_found` « elle n'existe pas », et
      // un demandeur non autorisé énumérerait l'annuaire une adresse à la fois.
      //
      // La parade tient en une ligne : on passe l'identifiant RÉSOLU (ou `null`) à la garde.
      // Sur `null`, `canReadPersonRecord` ne peut pas emprunter la branche « son propre
      // dossier » et retombe sur le niveau d'accès — donc un demandeur sans le niveau `full`
      // reçoit le MÊME refus dans les deux cas, et n'apprend rien.
      if (!data.employeeId && email) {
        const resolved = await empRepo.findByEmail(email);

        if (!canReadPersonRecord(_ctx?.requestContext, resolved?.id ?? null)) {
          logger.warn('Lecture de profil refusée — demandeur non autorisé (par email)');
          return {
            found: false as const,
            reason: 'not_authorized' as const,
            hint: NOT_AUTHORIZED_HINT,
          };
        }

        if (!resolved) {
          logger.warn('Aucun employé pour cette adresse');
          return {
            found: false as const,
            reason: 'employee_not_found' as const,
            hint: NOT_FOUND_HINT,
          };
        }

        return project(resolved, await onboardingRepo.findByEmployee(resolved.id));
      }

      const employeeId = data.employeeId as string;

      // ── Chemin IDENTIFIANT ────────────────────────────────────────────────
      // AVANT toute lecture en base. Un refus qui interroge d'abord la base laisse fuiter par
      // sa latence, et journalise une consultation qui n'aurait pas dû avoir lieu. Cette
      // propriété est verrouillée par test et ne doit PAS être perdue en ajoutant l'email.
      if (!canReadPersonRecord(_ctx?.requestContext, employeeId)) {
        logger.warn('Lecture de profil refusée — demandeur non autorisé', { employeeId });
        return {
          found: false as const,
          reason: 'not_authorized' as const,
          hint: NOT_AUTHORIZED_HINT,
        };
      }

      logger.info('Récupération profil employé', { employeeId });
      const employee = await empRepo.findById(employeeId);

      if (!employee) {
        // `warn` volontaire : un identifiant qui ne désigne personne signale
        // presque toujours une valeur fabriquée par le modèle.
        logger.warn('Aucun employé pour cet identifiant', { employeeId });
        return {
          found: false as const,
          reason: 'employee_not_found' as const,
          hint: NOT_FOUND_HINT,
        };
      }

      return project(employee, await onboardingRepo.findByEmployee(employeeId));
    },
  });
}

/**
 * Projection du couple employé / suivi, FACTORISÉE parce qu'elle a désormais DEUX appelants
 * (résolution par identifiant et par email). La dupliquer serait la garantie qu'un champ
 * ajouté d'un seul côté finisse par fuiter par l'autre — or c'est précisément ce que cette
 * projection existe pour empêcher.
 */
function project(employee: Employee, progress: OnboardingProgress | null) {
  // PROJECTION EXPLICITE, et non `return { employee }`.
  //
  // `DrizzleEmployeeRepository.findById` fait un `db.select()` sans argument
  // — donc un `SELECT *` sur 20 colonnes — puis un `as Employee`. Cette
  // assertion est effacée à la compilation : elle ne retire AUCUNE propriété
  // à l'exécution, et `JSON.stringify` sérialise l'objet réel. Les colonnes
  // `salary_amount`, `phone`, `emergency_contact_*` et `metadata` existent en
  // base et partiraient telles quelles dans le contexte du LLM, donc
  // potentiellement dans une réponse Slack visible par n'importe quel membre
  // du workspace.
  //
  // Le profil ne fuite rien AUJOURD'HUI seulement parce que l'entité
  // `Employee` ne déclare pas ces champs — une protection par coïncidence,
  // pas par conception. On énumère donc ce qu'on expose, sur le modèle de
  // `find-employee-by-email.ts`. Verrouillé par un test.
  //
  // La même règle s'applique à `progress`.
  //
  // ⚠️ `tasks` a disparu de ce retour le 2026-08-14, avec le suivi de tâches
  // lui-même. Il en était le poste de coût dominant : non borné, 19 champs par
  // ligne, 2 506 tokens mesurés pour 12 tâches avant projection, réémis à chaque
  // aller-retour. Ne pas le réintroduire sans borne ni projection.
  return {
    // Symétrique de `findEmployeeByEmail` : le modèle distingue le succès de
    // l'échec sur le MÊME champ, quel que soit le tool.
    found: true as const,
    employee: {
      id: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email,
      department: employee.department,
      position: employee.position,
      startDate: employee.startDate,
      status: employee.status,
      managerId: employee.managerId ?? null,
    },
    progress: progress
      ? {
          status: progress.status,
          // ⚠️ BORNÉ par le parcours qui existe AUJOURD'HUI. Constaté en production le
          // 2026-08-17 : le bot répondait « en cours (étape 1 sur 5) ». La ligne de suivi
          // datait d'avant le 2026-08-14, quand le parcours comptait cinq tâches ; celles-ci
          // ont été supprimées — aucun mécanisme ne pouvait les faire avancer — et
          // `ONBOARDING_TOTAL_STEPS` vaut 1 depuis. Mais le workflow, rendu IDEMPOTENT le
          // 2026-08-17, réutilise la ligne existante sans la corriger : le compteur périmé
          // survit et le bot annonce quatre étapes qui n'existent plus.
          //
          // C'est exactement le défaut que le retrait du suivi de tâches disait supprimer —
          // « un suivi qui ne bouge jamais est un suivi qui ment » — réintroduit par la
          // donnée plutôt que par le code. On corrige donc À LA LECTURE : le code sait ce
          // que vaut le parcours, la ligne ancienne non.
          currentStep: Math.min(progress.currentStep, ONBOARDING_TOTAL_STEPS),
          totalSteps: ONBOARDING_TOTAL_STEPS,
        }
      : null,
    // Le `hint` n'est payé que dans le cas dégradé : quand le suivi existe,
    // pas un caractère de plus dans le contexte du modèle.
    ...(progress ? {} : { onboardingHint: NO_PROGRESS_HINT }),
  };
}
