import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createEmployeeOnboardingWorkflow } from '../src/features/onboarding/application/workflows/employee-onboarding';
import { createDocumentWorkflow } from '../src/features/document/application/workflows/document-generation';
import { DrizzleEmployeeRepository } from '../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleOnboardingRepository } from '../src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';
import { DrizzleNotificationRepository } from '../src/features/notification/infrastructure/repositories/drizzle-notification.repository';
import { BrevoAdapter } from '../src/features/notification/infrastructure/providers/brevo.adapter';
import { SlackWorkspaceService } from '../src/features/notification/infrastructure/providers/slack-workspace.service';
import { PdfmakeService } from '../src/features/document/infrastructure/services/pdfmake.service';
import { logger } from '../src/shared/logger';
import {
  OnboardingOutcome,
  describeDegradation,
  type StepFailure,
} from '../src/features/onboarding/domain/value-objects/onboarding-outcome';

/**
 * Traduit un run d'onboarding en verdict de rapport.
 *
 * ⚠️ `result.status === 'success'` ne dit QUE « le workflow est allé au bout ».
 * Les étapes best-effort (email de bienvenue, invitation Slack, tâches) avalent
 * leur erreur : lire ce seul champ rendait `PASS` alors qu'aucun email n'était
 * parti. Le verdict est `result.result.outcome`.
 */
function classifyOnboarding(result: { status: string; result?: unknown; error?: unknown }): {
  status: 'PASS' | 'DEGRADED' | 'FAIL';
  notes?: string;
  error?: string;
} {
  if (result.status !== 'success') {
    return {
      status: 'FAIL',
      error: result.status === 'failed' ? String(result.error) : `Status: ${result.status}`,
    };
  }

  const out = result.result as
    { outcome?: OnboardingOutcome; degradedSteps?: StepFailure[] } | undefined;

  if (out?.outcome === OnboardingOutcome.Degraded) {
    return {
      status: 'DEGRADED',
      notes: `étapes best-effort en échec : ${describeDegradation(out.degradedSteps ?? [])}`,
    };
  }

  return { status: 'PASS', notes: `outcome=${out?.outcome}` };
}

// Configuration de test
const TEST_EMAIL = 'ridwanenico77@gmail.com';
const TEST_SLACK_CHANNEL = 'C0BJGBVB5HP';
const TEST_DEPARTMENT = 'Engineering';
const TEST_POSITION = 'Software Engineer';

// Données de test simplifiées
const testEmployeeData = {
  firstName: 'Ridwan',
  lastName: 'Nico',
  email: TEST_EMAIL,
  department: TEST_DEPARTMENT,
  position: TEST_POSITION,
  startDate: new Date().toISOString(),
  managerId: null,
  slackChannelId: TEST_SLACK_CHANNEL,
};

async function runProductionTestsWithMocks() {
  logger.info('=== DÉBUT TESTS PRODUCTION (MOCKED) ===');

  // Initialisation des repositories et providers
  const employeeRepo = new DrizzleEmployeeRepository();
  const onboardingRepo = new DrizzleOnboardingRepository();
  const notificationRepo = new DrizzleNotificationRepository();

  const emailProvider = new BrevoAdapter(
    process.env.BREVO_API_KEY || 'mock-key',
    process.env.NOTIFICATION_FROM || 'noreply@kisso.com',
  );
  const slackProvider = new SlackWorkspaceService(process.env.SLACK_BOT_TOKEN || 'mock-token');
  const pdfService = new PdfmakeService();

  // Création des workflows
  const employeeOnboardingWorkflow = createEmployeeOnboardingWorkflow({
    employeeRepo,
    onboardingRepo,
    notificationRepo,
    emailProvider,
    slackProvider,
  });

  const documentGenerationWorkflow = createDocumentWorkflow({
    employeeRepo,
    pdfService,
  });

  const results: {
    test: string;
    // `DEGRADED` : le parcours a abouti mais une étape best-effort a échoué.
    // Le rapporter `PASS` reproduirait le faux « ✅ » historique.
    status: 'PASS' | 'DEGRADED' | 'FAIL';
    error?: string;
    duration?: number;
    notes?: string;
  }[] = [];

  // Test 1: Création employé avec données complètes
  try {
    const start = Date.now();
    logger.info('Test 1: Création employé avec données complètes', testEmployeeData);

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({ inputData: testEmployeeData });

    const duration = Date.now() - start;
    const verdict = classifyOnboarding(result);
    if (verdict.status === 'PASS')
      logger.info('Test 1 RÉUSSI', { result: result.result, duration });
    else if (verdict.status === 'DEGRADED')
      logger.warn('Test 1 DÉGRADÉ', { notes: verdict.notes, duration });
    else logger.error('Test 1 ÉCHOUÉ', { error: verdict.error });
    results.push({ test: 'Création employé complet', duration, ...verdict });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Test 1 ÉCHOUÉ', { error: message });
    results.push({ test: 'Création employé complet', status: 'FAIL', error: message });
  }

  // Test 2: Création employé sans managerId
  try {
    const start = Date.now();
    logger.info('Test 2: Création employé sans managerId');

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({
      inputData: {
        ...testEmployeeData,
        email: `test2-${Date.now()}@example.com`,
        managerId: null,
      },
    });

    const duration = Date.now() - start;
    const verdict = classifyOnboarding(result);
    if (verdict.status === 'PASS')
      logger.info('Test 2 RÉUSSI', { result: result.result, duration });
    else if (verdict.status === 'DEGRADED')
      logger.warn('Test 2 DÉGRADÉ', { notes: verdict.notes, duration });
    else logger.error('Test 2 ÉCHOUÉ', { error: verdict.error });
    results.push({ test: 'Création sans managerId', duration, ...verdict });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Test 2 ÉCHOUÉ', { error: message });
    results.push({ test: 'Création sans managerId', status: 'FAIL', error: message });
  }

  // Test 3: Création employé sans slackChannelId
  try {
    const start = Date.now();
    logger.info('Test 3: Création employé sans slackChannelId');

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({
      inputData: {
        ...testEmployeeData,
        email: `test3-${Date.now()}@example.com`,
        slackChannelId: null,
      },
    });

    const duration = Date.now() - start;
    const verdict = classifyOnboarding(result);
    if (verdict.status === 'PASS')
      logger.info('Test 3 RÉUSSI', { result: result.result, duration });
    else if (verdict.status === 'DEGRADED')
      logger.warn('Test 3 DÉGRADÉ', { notes: verdict.notes, duration });
    else logger.error('Test 3 ÉCHOUÉ', { error: verdict.error });
    results.push({ test: 'Création sans slackChannelId', duration, ...verdict });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Test 3 ÉCHOUÉ', { error: message });
    results.push({ test: 'Création sans slackChannelId', status: 'FAIL', error: message });
  }

  // Test 4: Tentative création avec email dupliqué
  try {
    const start = Date.now();
    logger.info('Test 4: Tentative création avec email dupliqué');

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({ inputData: testEmployeeData });

    const duration = Date.now() - start;
    if (result.status === 'failed') {
      const message = result.error ? String(result.error) : 'Unknown error';
      if (message.includes('existe déjà') || message.includes('ConflictError')) {
        logger.info('Test 4 RÉUSSI: Erreur attendue détectée', { error: message });
        results.push({ test: 'Email dupliqué', status: 'PASS', duration });
      } else {
        logger.error('Test 4 ÉCHOUÉ: Mauvaise erreur', { error: message });
        results.push({ test: 'Email dupliqué', status: 'FAIL', error: message });
      }
    } else {
      logger.error('Test 4 ÉCHOUÉ: Devrait lever une erreur pour email dupliqué');
      results.push({
        test: 'Email dupliqué',
        status: 'FAIL',
        error: 'Devrait lever ConflictError',
      });
    }
  } catch (error) {
    const duration = Date.now() - (Date.now() - (Date.now() - 100)); // Approximation
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('existe déjà') || message.includes('ConflictError')) {
      logger.info('Test 4 RÉUSSI: Erreur attendue détectée', { error: message });
      results.push({ test: 'Email dupliqué', status: 'PASS', duration });
    } else {
      logger.error('Test 4 ÉCHOUÉ: Mauvaise erreur', { error: message });
      results.push({ test: 'Email dupliqué', status: 'FAIL', error: message });
    }
  }

  // Test 5: Workflow DocumentGeneration
  try {
    const start = Date.now();
    logger.info('Test 5: Workflow DocumentGeneration');

    // Créer un employé pour avoir un ID valide
    const run = await employeeOnboardingWorkflow.createRun();
    const employeeResult = await run.start({
      inputData: {
        ...testEmployeeData,
        email: `test-doc-${Date.now()}@example.com`,
      },
    });

    if (employeeResult.status !== 'success') {
      throw new Error('Failed to create employee for document test');
    }

    const docRun = await documentGenerationWorkflow.createRun();
    const docResult = await docRun.start({
      inputData: {
        employeeId: employeeResult.result.employeeId,
        documentType: 'welcome_letter',
      },
    });

    const duration = Date.now() - start;
    if (docResult.status === 'success') {
      logger.info('Test 5 RÉUSSI', { result: docResult.result, duration });
      results.push({ test: 'DocumentGeneration', status: 'PASS', duration });
    } else {
      const message =
        docResult.status === 'failed' ? String(docResult.error) : `Status: ${docResult.status}`;
      logger.error('Test 5 ÉCHOUÉ', { error: message });
      results.push({ test: 'DocumentGeneration', status: 'FAIL', error: message });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Test 5 ÉCHOUÉ', { error: message });
    results.push({ test: 'DocumentGeneration', status: 'FAIL', error: message });
  }

  // Résumé
  logger.info('=== RÉSUMÉ DES TESTS ===');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const degraded = results.filter((r) => r.status === 'DEGRADED').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  results.forEach((r) => {
    logger.info(
      `${r.test}: ${r.status} ${r.duration ? `(${r.duration}ms)` : ''} ${r.notes ?? ''}`,
      r.error ? { error: r.error } : {},
    );
  });

  logger.info(`TOTAL: ${passed} PASS, ${degraded} DEGRADED, ${failed} FAIL`);

  if (failed > 0) {
    process.exit(1);
  }
}

runProductionTestsWithMocks().catch((error) => {
  logger.error('Erreur critique lors des tests', { error });
  process.exit(1);
});
