/**
 * Garde-fou de BUDGET sur les tool-results.
 *
 * Contexte — le plafond qui casse la production est le quota JOURNALIER Groq
 * (100 000 tokens, soit ≈ 19 messages). Le préfixe (instructions + schémas des
 * tools) est déjà repayé à chaque aller-retour ; un tool-result volumineux s'y
 * ajoute et reste dans l'historique pour TOUS les tours suivants.
 *
 * ⚠️ Le poste de coût historique de ce fichier — `tasks` NON BORNÉ dans
 * `getEmployeeProfile`, 19 champs par ligne, 979 tokens mesurés pour un seul
 * résultat — a disparu le 2026-08-14 avec le suivi de tâches lui-même. Ce qui
 * reste ici verrouille les deux propriétés qui survivent à ce retrait :
 *   1. la PROJECTION (seuls les champs utiles sortent — c'est aussi une
 *      protection de confidentialité : `metadata` et `salaryAmount` ne fuitent pas) ;
 *   2. l'INDÉPENDANCE de la taille du résultat vis-à-vis du contenu écrit par le
 *      modèle (`generateDocument`).
 *
 * Et un garde-fou de NON-RETOUR : le résultat de `getEmployeeProfile` ne doit
 * plus JAMAIS porter de tâches.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { InMemoryDocumentRepository } from '../../../src/features/document/infrastructure/repositories/in-memory-document.repository';
import type { DocumentRenderer } from '../../../src/features/document/domain/ports/document-renderer';
import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { InMemoryOnboardingRepository } from '../../../src/features/onboarding/infrastructure/repositories/in-memory-onboarding.repository';
import type { Employee } from '../../../src/features/employee/domain/entities/employee';
import type { OnboardingProgress } from '../../../src/features/onboarding/domain/entities/onboarding-progress';
import { ONBOARDING_TOTAL_STEPS } from '../../../src/features/onboarding/domain/services/onboarding-plan';
import {
  EmployeeStatus,
  OnboardingStatus,
  DocumentFormat,
  DocumentType,
} from '../../../src/shared/types';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

const employee: Employee = {
  id: EMPLOYEE_ID,
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  department: 'Engineering',
  position: 'Software Engineer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: EmployeeStatus.Pending,
  managerId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const progress: OnboardingProgress = {
  id: '22222222-2222-4222-8222-222222222222',
  employeeId: EMPLOYEE_ID,
  status: OnboardingStatus.InProgress,
  currentStep: 3,
  totalSteps: 8,
  startedAt: '2026-08-10T00:00:00.000Z',
  completedAt: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

let employeeRepo: InMemoryEmployeeRepository;
let onboardingRepo: InMemoryOnboardingRepository;

beforeEach(async () => {
  employeeRepo = new InMemoryEmployeeRepository();
  onboardingRepo = new InMemoryOnboardingRepository();
  await employeeRepo.save(employee);
  await onboardingRepo.save(progress);
});

function profileTool() {
  return makeGetEmployeeProfile(employeeRepo, onboardingRepo);
}

type ProfileResult = {
  employee: Record<string, unknown>;
  progress: Record<string, unknown> | null;
};

describe('getEmployeeProfile — budget du tool-result', () => {
  it('ne porte AUCUNE tâche — non-retour du suivi supprimé le 2026-08-14', async () => {
    // Garde-fou de NON-RETOUR, et non de mise en forme. `tasks` était le poste de coût
    // dominant de tout le dépôt : non borné, 19 champs par ligne, réémis à chaque
    // aller-retour. Le rebrancher sans borne ni projection ramènerait 979 tokens par
    // appel sur un budget de ≈ 19 messages par jour.
    const result = (await profileTool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult & Record<string, unknown>;

    expect(result.tasks).toBeUndefined();
    expect(result.totalTasks).toBeUndefined();
    expect(result.shown).toBeUndefined();
  });

  it('projette la progression sans ses champs techniques', async () => {
    const result = (await profileTool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult;

    // ⚠️ La FIXTURE porte `currentStep: 3, totalSteps: 8`, et le résultat ne les recopie plus.
    // C'est voulu depuis le 2026-08-18 : le compteur est borné par le parcours qui existe
    // AUJOURD'HUI (`ONBOARDING_TOTAL_STEPS`). Constaté en production la veille — « en cours
    // (étape 1 sur 5) » — sur une ligne écrite avant le retrait des cinq tâches, que le
    // workflow devenu idempotent réutilise sans la corriger.
    //
    // Ce que ce test vérifie reste sa raison d'être : la FORME de la projection, trois champs
    // et pas un de plus. Les valeurs, elles, viennent désormais du code plutôt que d'une
    // ligne périmée.
    expect(Object.keys(result.progress!).sort()).toEqual(['currentStep', 'status', 'totalSteps']);
    expect(result.progress).toEqual({
      status: OnboardingStatus.InProgress,
      currentStep: ONBOARDING_TOTAL_STEPS,
      totalSteps: ONBOARDING_TOTAL_STEPS,
    });
  });

  it('rend progress à null quand aucune progression n existe', async () => {
    const vide = new InMemoryOnboardingRepository();
    const result = (await makeGetEmployeeProfile(employeeRepo, vide).execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult;

    expect(result.progress).toBeNull();
  });

  it('tient très largement sous 350 tokens', async () => {
    const serialise = JSON.stringify(
      await profileTool().execute!({ employeeId: EMPLOYEE_ID } as never, {} as never),
    );
    // Ratio 3,5 caractères/token, calibré sur les mesures réelles du projet.
    const tokens = Math.round(serialise.length / 3.5);

    // Mesure historique sur le même jeu d'essai, tâches comprises : 979 tokens.
    // Le seuil est un garde-fou de NON-RÉGRESSION, pas une cible.
    expect(tokens, `tool-result de ${tokens} tokens (${serialise.length} caractères)`).toBeLessThan(
      350,
    );
  });

  it('ne laisse fuiter aucune colonne sensible de la fiche employé', async () => {
    // `DrizzleEmployeeRepository.findById` fait un `SELECT *` sur 20 colonnes puis un
    // `as Employee` — assertion effacée à la compilation, qui ne retire rien à
    // l'exécution. Seule la projection explicite du tool protège.
    await employeeRepo.save({
      ...employee,
      // Champs hors entité `Employee` : ils existent en base et partiraient tels quels.
      salaryAmount: 42_000,
      metadata: { note: 'confidentiel', internalTicket: 'OPS-4821' },
    } as never);

    const serialise = JSON.stringify(
      await profileTool().execute!({ employeeId: EMPLOYEE_ID } as never, {} as never),
    );

    expect(serialise).not.toContain('confidentiel');
    expect(serialise).not.toContain('OPS-4821');
    expect(serialise).not.toContain('42000');
  });
});

/**
 * `generateDocument` portait exactement le même défaut que `getEmployeeProfile`, en pire :
 * il retournait l'entité `Document` COMPLÈTE, `content` compris — c'est-à-dire qu'il
 * renvoyait au modèle, à ses frais, le texte que le modèle venait lui-même d'écrire. Et ce
 * texte restait ensuite dans l'historique de TOUS les tours suivants.
 *
 * Mesure sur un guide d'intégration réaliste (2 000 caractères de corps) : ~600 tokens de
 * tool-result, contre ~40 après projection. La propriété qui compte n'est pas le chiffre
 * mais l'INDÉPENDANCE : le résultat ne grandit plus avec le document.
 */
describe('generateDocument — budget du tool-result', () => {
  const DOCUMENT_EMPLOYEE = {
    ...employee,
    id: EMPLOYEE_ID,
  };

  /** Renderer factice : le rendu réel est couvert ailleurs, ici seule la taille compte. */
  const renderer: DocumentRenderer = {
    format: DocumentFormat.Pdf,
    async render() {
      return {
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'guide-de-demarrage.pdf',
        mimeType: 'application/pdf',
      };
    },
  };

  async function generate(content: string) {
    const documentRepo = new InMemoryDocumentRepository();
    const directory = new InMemoryEmployeeRepository();
    await directory.save(DOCUMENT_EMPLOYEE);

    const tool = makeGenerateDocument({
      documentRepo,
      employeeRepo: directory,
      renderers: [renderer],
    });

    return (await tool.execute!(
      {
        employeeId: EMPLOYEE_ID,
        type: DocumentType.Guide,
        title: 'Guide de démarrage',
        content,
        format: DocumentFormat.Pdf,
        deliverTo: 'none',
      } as never,
      {} as never,
    )) as Record<string, unknown>;
  }

  it('ne renvoie jamais le contenu du document au modèle', async () => {
    const serialise = JSON.stringify(await generate('SECRET-CONTENU-DU-GUIDE '.repeat(50)));

    expect(serialise).not.toContain('SECRET-CONTENU-DU-GUIDE');
  });

  it('rend une taille INDÉPENDANTE de la longueur du contenu', async () => {
    const court = JSON.stringify(await generate('Bienvenue.'));
    const long = JSON.stringify(await generate('Bienvenue chez Kisso. '.repeat(500)));

    // Seul l'UUID du document change, et il est de longueur fixe.
    expect(Math.abs(long.length - court.length)).toBe(0);
  });

  it('tient sous 60 tokens, verdict de livraison compris', async () => {
    const serialise = JSON.stringify(await generate('Bienvenue chez Kisso. '.repeat(500)));
    const tokens = Math.round(serialise.length / 3.5);

    expect(tokens, `tool-result de ${tokens} tokens (${serialise.length} caractères)`).toBeLessThan(
      60,
    );
  });

  it('rend TOUJOURS le verdict de livraison — sans lui le modèle ne peut pas dire la vérité', async () => {
    const result = await generate('Bienvenue.');

    expect(result.delivery).toBeDefined();
    expect(result.documentId).toBeDefined();
    expect(result.format).toBe(DocumentFormat.Pdf);
  });
});
