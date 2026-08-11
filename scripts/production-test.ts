import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Override DATABASE_URL to use local SQLite for testing.
// ⚠️ Ce script N'ÉCRIT PAS dans Turso : la base Turso (DATABASE_URL de .env)
// ne contient que les tables internes de Mastra, pas le schéma applicatif.
process.env.DATABASE_URL = 'file:./data/kisso.db';
delete process.env.DATABASE_AUTH_TOKEN;

import { createEmployeeOnboardingWorkflow } from '../src/features/onboarding/application/workflows/employee-onboarding';
import { createDocumentWorkflow } from '../src/features/document/application/workflows/document-generation';
import { DrizzleEmployeeRepository } from '../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleOnboardingRepository } from '../src/features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';
import { DrizzleNotificationRepository } from '../src/features/notification/infrastructure/repositories/drizzle-notification.repository';
import { BrevoAdapter } from '../src/features/notification/infrastructure/providers/brevo.adapter';
import { SlackWorkspaceService } from '../src/features/notification/infrastructure/providers/slack-workspace.service';
import { PdfmakeService } from '../src/features/document/infrastructure/services/pdfmake.service';
import {
  OnboardingOutcome,
  describeDegradation,
  type StepFailure,
} from '../src/features/onboarding/domain/value-objects/onboarding-outcome';

// Configuration de test — identités de test dédiées du projet
const TEST_EMAIL = 'karylsoumaila1@gmail.com';
const TEST_SLACK_CHANNEL = 'C0BJGBVB5HP';
const TEST_DEPARTMENT = 'Engineering';
const TEST_POSITION = 'Software Engineer';

const RUN_ID = Date.now();
// Alias plus-addressing sur l'identité de test : la boîte reste celle de
// TEST_EMAIL, mais chaque run est idempotent côté base.
const runEmail = (tag: string) => `karylsoumaila1+${tag}${RUN_ID}@gmail.com`;

const baseEmployeeData = {
  firstName: 'Ridwan',
  lastName: 'Nico',
  department: TEST_DEPARTMENT,
  position: TEST_POSITION,
  startDate: new Date().toISOString(),
  managerId: null as string | null,
  slackChannelId: TEST_SLACK_CHANNEL as string | null,
};

/**
 * `DEGRADED` existe pour la même raison que `OnboardingOutcome.Degraded` : un
 * parcours peut aboutir sans que l'email de bienvenue soit parti. Le rapporter
 * `PASS` est précisément le faux « ✅ » que ce script a produit pendant des
 * mois — mais le rapporter `FAIL` effacerait le fait que l'employé, lui, a bien
 * été créé. Trois états côté rapport, comme côté workflow.
 */
type TestResult = {
  test: string;
  status: 'PASS' | 'DEGRADED' | 'FAIL';
  error?: string;
  duration?: number;
  notes?: string;
};

/** Un run Mastra qui échoue ne *throw* pas : il retourne { status: 'failed' }.
 *  Sans cette vérification, un échec passe pour un succès (bug historique). */
function assertRunSucceeded(result: { status: string; error?: unknown }, label: string) {
  if (result.status !== 'success') {
    const err = result.error as { message?: string } | undefined;
    throw new Error(
      `${label}: workflow status="${result.status}" — ${err?.message ?? JSON.stringify(result.error)}`,
    );
  }
}

async function runProductionTests() {
  console.log('=== DÉBUT TESTS PRODUCTION (données et identifiants réels) ===');

  const results: TestResult[] = [];

  // Setup real dependencies
  const employeeRepo = new DrizzleEmployeeRepository();
  const onboardingRepo = new DrizzleOnboardingRepository();
  const notificationRepo = new DrizzleNotificationRepository();

  const brevoKey = process.env.BREVO_API_KEY ?? '';
  if (!brevoKey) {
    console.warn(
      '⚠️  BREVO_API_KEY est ABSENT/VIDE — AUCUN email ne sera réellement envoyé.\n' +
        "    Les workflows attrapent l'erreur Brevo : le run reste `success`, mais\n" +
        "    `outcome` bascule sur `degraded` et l'étape `welcomeEmail` est nommée.\n" +
        '    Le chemin email est donc NON PROUVÉ par ce run.',
    );
  }

  const emailProvider = new BrevoAdapter(
    brevoKey,
    process.env.NOTIFICATION_FROM ?? 'noreply@kissohq.slack.com',
  );
  const slackProvider = new SlackWorkspaceService(process.env.SLACK_BOT_TOKEN ?? '');
  const pdfService = new PdfmakeService();

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

  // ── Test 1: onboarding complet (email + channel Slack) ────────────────────
  const test1Email = runEmail('full');
  try {
    const start = Date.now();
    console.log('Test 1: Création employé avec données complètes', { email: test1Email });

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({
      inputData: { ...baseEmployeeData, email: test1Email },
    });
    assertRunSucceeded(result, 'Onboarding complet');

    const duration = Date.now() - start;
    // ⚠️ `assertRunSucceeded` ne prouve QUE l'absence d'exception. Le verdict
    // du parcours est `outcome` : les étapes best-effort (email, Slack, tâches)
    // avalent leur erreur et laissent le run en `success`.
    const out = result.result as {
      outcome: OnboardingOutcome;
      emailSent: boolean;
      slackInvited: boolean;
      degradedSteps: StepFailure[];
    };
    const degraded = out.outcome === OnboardingOutcome.Degraded;
    const notes =
      `outcome=${out.outcome} emailSent=${out.emailSent} slackInvited=${out.slackInvited}` +
      (degraded ? ` — étapes en échec : ${describeDegradation(out.degradedSteps ?? [])}` : '');

    if (degraded) console.warn('Test 1 DÉGRADÉ', { notes, duration });
    else console.log('Test 1 RÉUSSI', { result: out, duration });

    results.push({
      test: 'Création employé complet',
      status: degraded ? 'DEGRADED' : 'PASS',
      duration,
      notes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Test 1 ÉCHOUÉ', { error: message });
    results.push({ test: 'Création employé complet', status: 'FAIL', error: message });
  }

  // ── Test 2: sans managerId ────────────────────────────────────────────────
  try {
    const start = Date.now();
    console.log('Test 2: Création employé sans managerId');

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({
      inputData: { ...baseEmployeeData, email: runEmail('nomgr'), managerId: null },
    });
    assertRunSucceeded(result, 'Sans managerId');

    const duration = Date.now() - start;
    console.log('Test 2 RÉUSSI', { result: result.result, duration });
    results.push({ test: 'Création sans managerId', status: 'PASS', duration });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Test 2 ÉCHOUÉ', { error: message });
    results.push({ test: 'Création sans managerId', status: 'FAIL', error: message });
  }

  // ── Test 3: sans slackChannelId ───────────────────────────────────────────
  try {
    const start = Date.now();
    console.log('Test 3: Création employé sans slackChannelId');

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({
      inputData: { ...baseEmployeeData, email: runEmail('noslack'), slackChannelId: null },
    });
    assertRunSucceeded(result, 'Sans slackChannelId');

    const duration = Date.now() - start;
    console.log('Test 3 RÉUSSI', { result: result.result, duration });
    results.push({ test: 'Création sans slackChannelId', status: 'PASS', duration });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Test 3 ÉCHOUÉ', { error: message });
    results.push({ test: 'Création sans slackChannelId', status: 'FAIL', error: message });
  }

  // ── Test 4: email dupliqué → ConflictError attendue ───────────────────────
  // Réutilise l'email du Test 1, donc le doublon est réel et le test idempotent.
  try {
    const start = Date.now();
    console.log('Test 4: Tentative création avec email dupliqué', { email: test1Email });

    const run = await employeeOnboardingWorkflow.createRun();
    const result = await run.start({
      inputData: { ...baseEmployeeData, email: test1Email },
    });

    const duration = Date.now() - start;
    if (result.status === 'failed') {
      const errorObj = result.error as { message?: string; name?: string } | undefined;
      const errorMessage = errorObj?.message || String(result.error);
      const errorName = errorObj?.name || '';

      if (
        errorMessage.includes('existe déjà') ||
        errorMessage.includes('ConflictError') ||
        errorMessage.includes('already exists') ||
        errorName === 'ConflictError'
      ) {
        console.log('Test 4 RÉUSSI: ConflictError attendue détectée', { error: result.error });
        results.push({ test: 'Email dupliqué', status: 'PASS', duration });
      } else {
        console.error('Test 4 ÉCHOUÉ: Mauvaise erreur', { error: result.error });
        results.push({ test: 'Email dupliqué', status: 'FAIL', error: errorMessage });
      }
    } else {
      console.error('Test 4 ÉCHOUÉ: Devrait échouer pour email dupliqué');
      results.push({
        test: 'Email dupliqué',
        status: 'FAIL',
        error: 'Devrait lever ConflictError',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('existe déjà') || message.includes('ConflictError')) {
      console.log('Test 4 RÉUSSI: ConflictError attendue détectée', { error: message });
      results.push({ test: 'Email dupliqué', status: 'PASS' });
    } else {
      console.error('Test 4 ÉCHOUÉ: Mauvaise erreur', { error: message });
      results.push({ test: 'Email dupliqué', status: 'FAIL', error: message });
    }
  }

  // ── Test 5: workflow DocumentGeneration ───────────────────────────────────
  try {
    const start = Date.now();
    console.log('Test 5: Workflow DocumentGeneration');

    const run = await employeeOnboardingWorkflow.createRun();
    const employeeResult = await run.start({
      inputData: { ...baseEmployeeData, email: runEmail('doc') },
    });
    assertRunSucceeded(employeeResult, 'Onboarding préalable à DocumentGeneration');

    const docRun = await documentGenerationWorkflow.createRun();
    const docResult = await docRun.start({
      inputData: {
        employeeId: (employeeResult.result as { employeeId: string }).employeeId,
        documentType: 'welcome_letter',
      },
    });
    assertRunSucceeded(docResult, 'DocumentGeneration');

    const duration = Date.now() - start;
    console.log('Test 5 RÉUSSI', { docResult: docResult.result, duration });
    results.push({ test: 'DocumentGeneration', status: 'PASS', duration });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Test 5 ÉCHOUÉ', { error: message });
    results.push({ test: 'DocumentGeneration', status: 'FAIL', error: message });
  }

  // ── Test 6: Slack workspace — LECTURE SEULE ───────────────────────────────
  // Prouve token + scopes + résolution d'identité sans aucun effet de bord
  // (pas d'invitation, pas de message posté).
  try {
    const start = Date.now();
    console.log('Test 6: Slack workspace (lecture seule)');

    const member = await slackProvider.findUserByEmail(TEST_EMAIL);
    if (!member) throw new Error(`Utilisateur Slack introuvable pour ${TEST_EMAIL}`);

    const channelMembers = await slackProvider.getChannelMembers(TEST_SLACK_CHANNEL);
    const alreadyIn = channelMembers.includes(member.id);

    const duration = Date.now() - start;
    console.log('Test 6 RÉUSSI', { slackUserId: member.id, alreadyIn, duration });
    results.push({
      test: 'Slack workspace (lecture seule)',
      status: 'PASS',
      duration,
      notes: `user=${member.id} déjà membre de ${TEST_SLACK_CHANNEL}=${alreadyIn}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Test 6 ÉCHOUÉ', { error: message });
    results.push({ test: 'Slack workspace (lecture seule)', status: 'FAIL', error: message });
  }

  // ── Test 7: envoi email réel via Brevo ────────────────────────────────────
  // Rend l'absence de BREVO_API_KEY BRUYANTE au lieu de silencieuse.
  try {
    const start = Date.now();
    console.log('Test 7: Envoi email réel via Brevo');

    if (!brevoKey) {
      throw new Error(
        'BREVO_API_KEY absent : le chemin email est NON PROUVÉ. ' +
          'Renseigner BREVO_API_KEY dans .env (et dans les variables Vercel) pour lever ce blocage.',
      );
    }

    await emailProvider.sendEmail(
      TEST_EMAIL,
      `[Kisso] Test d'intégration ${new Date().toISOString()}`,
      '<p>Email de vérification du chemin Brevo. Aucune action requise.</p>',
    );

    const duration = Date.now() - start;
    console.log('Test 7 RÉUSSI', { duration });
    results.push({ test: 'Email réel (Brevo)', status: 'PASS', duration });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Test 7 ÉCHOUÉ', { error: message });
    results.push({ test: 'Email réel (Brevo)', status: 'FAIL', error: message });
  }

  // ── Résumé ────────────────────────────────────────────────────────────────
  console.log('=== RÉSUMÉ DES TESTS ===');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const degraded = results.filter((r) => r.status === 'DEGRADED').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  results.forEach((r) => {
    console.log(
      `${r.test}: ${r.status} ${r.duration ? `(${r.duration}ms)` : ''} ${r.notes ?? ''}`,
      r.error ? { error: r.error } : {},
    );
  });

  console.log(`TOTAL: ${passed} PASS, ${degraded} DEGRADED, ${failed} FAIL`);

  // Un parcours dégradé sort en échec : ce script sert à PROUVER le chemin
  // complet (email compris). Un « 7 PASS » rendu alors qu'aucun email n'est
  // parti est exactement le rapport mensonger qu'on supprime ici. La distinction
  // avec FAIL reste lisible dans le résumé ci-dessus.
  if (failed > 0 || degraded > 0) {
    process.exit(1);
  }
}

runProductionTests().catch((error) => {
  console.error('Erreur critique lors des tests', { error });
  process.exit(1);
});
