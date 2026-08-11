/**
 * Mesure du coût en tokens d'entrée (FLOOR) des 3 agents Mastra.
 *
 * Le « floor » = ce qui est envoyé au LLM AVANT le moindre message utilisateur :
 *   instructions (en-tête sécurité + bloc métier) + description et schéma JSON de
 *   CHAQUE tool câblé à l'agent dans src/mastra/index.ts.
 *
 * Ce préfixe est REPAYÉ à chaque aller-retour (K = 2-3 pour un flux avec tool call),
 * donc chaque token économisé ici est multiplié par K.
 *
 * Ratio 3,5 caractères/token — calibré sur les mesures réelles du projet
 * (SYSTEM_SECURITY_PROMPT : 1 308 caractères ≈ 374 tokens observés).
 *
 * Usage : npx tsx _measure.mts
 */
import { zodToJsonSchema } from '@mastra/schema-compat/zod-to-json';

const stub: any = new Proxy(function () {}, {
  get: () => stub,
  apply: () => stub,
  construct: () => stub,
});

const CHARS_PER_TOKEN = 3.5;
const tok = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);

const R = '/home/karyl/mastra/src';

const makeTool = {
  findEmployeeByEmail: async () =>
    (await import(`${R}/features/employee/application/tools/find-employee-by-email`)).makeFindEmployeeByEmail(stub),
  getEmployeeProfile: async () =>
    (await import(`${R}/features/employee/application/tools/get-employee-profile`)).makeGetEmployeeProfile(stub, stub, stub),
  updateOnboardingStatus: async () =>
    (await import(`${R}/features/onboarding/application/tools/update-onboarding-status`)).makeUpdateOnboardingStatus(stub),
  getTaskList: async () =>
    (await import(`${R}/features/employee/application/tools/get-task-list`)).makeGetTaskList(stub),
  generateQuestionnaire: async () =>
    (await import(`${R}/features/questionnaire/application/tools/generate-questionnaire`)).makeGenerateQuestionnaire(stub),
  evaluateResponse: async () =>
    (await import(`${R}/features/questionnaire/application/tools/evaluate-response`)).makeEvaluateResponse(stub, stub),
  generateDocument: async () =>
    (await import(`${R}/features/document/application/tools/generate-document`)).makeGenerateDocument(stub),
  sendNotification: async () =>
    (await import(`${R}/features/notification/application/tools/send-notification`)).makeSendNotification(stub, stub, stub, stub, stub),
  scheduleReminder: async () =>
    (await import(`${R}/features/notification/application/tools/schedule-reminder`)).makeScheduleReminder(stub),
  getNotificationHistory: async () =>
    (await import(`${R}/features/notification/application/tools/get-notification-history`)).makeGetNotificationHistory(stub),
} as const;

type ToolName = keyof typeof makeTool;

/** Câblage RÉEL de src/mastra/index.ts (lignes 143-167). */
const agents: Array<{
  id: string;
  make: (tools: any) => Promise<any>;
  tools: ToolName[];
}> = [
  {
    id: 'onboardingOrchestrator',
    make: async (tools) =>
      (await import(`${R}/features/onboarding/application/agents/onboarding-orchestrator`)).makeOnboardingOrchestrator(tools),
    tools: ['findEmployeeByEmail', 'getEmployeeProfile', 'updateOnboardingStatus', 'getTaskList', 'generateDocument'],
  },
  {
    id: 'questionnaireEngine',
    make: async (tools) =>
      (await import(`${R}/features/questionnaire/application/agents/questionnaire-engine`)).makeQuestionnaireEngine(tools),
    tools: ['generateQuestionnaire', 'evaluateResponse', 'getEmployeeProfile'],
  },
  {
    id: 'notificationAgent',
    make: async (tools) =>
      (await import(`${R}/features/notification/application/agents/notification-agent`)).makeNotificationAgent(tools),
    tools: ['sendNotification', 'scheduleReminder', 'getNotificationHistory', 'getEmployeeProfile'],
  },
];

const built = new Map<ToolName, any>();
async function getTool(name: ToolName) {
  if (!built.has(name)) built.set(name, await makeTool[name]());
  return built.get(name);
}

const grand: Array<[string, number]> = [];

for (const agent of agents) {
  const tools: Record<string, any> = {};
  for (const n of agent.tools) tools[n] = await getTool(n);

  const built_ = await agent.make(tools);
  // `instructions` d'un Agent Mastra : figées à la construction.
  const instr: string =
    typeof built_.instructions === 'string' ? built_.instructions : String(await built_.getInstructions?.());
  const instrTok = tok(instr);

  console.log(`\n=== ${agent.id} ===`);
  console.log(`  ${'instructions'.padEnd(24)} ${String(instrTok).padStart(5)}`);

  let toolsTok = 0;
  for (const n of agent.tools) {
    const t = tools[n];
    const d = tok(`${t.id ?? n}${t.description ?? ''}`);
    const s = tok(JSON.stringify(zodToJsonSchema(t.inputSchema)));
    toolsTok += d + s;
    console.log(
      `  ${n.padEnd(24)} ${String(d + s).padStart(5)}   (desc=${String(d).padStart(4)} schema=${String(s).padStart(4)})`,
    );
  }

  const total = instrTok + toolsTok;
  grand.push([agent.id, total]);
  console.log(`  ${'—'.repeat(40)}`);
  console.log(`  ${'FLOOR'.padEnd(24)} ${String(total).padStart(5)} tokens  (instr=${instrTok} + tools=${toolsTok})`);
}

console.log('\n=== RÉCAPITULATIF (floor par agent, tokens) ===');
for (const [id, t] of grand) console.log(`  ${id.padEnd(24)} ${String(t).padStart(5)}`);
console.log(`  ${'SOMME'.padEnd(24)} ${String(grand.reduce((a, [, t]) => a + t, 0)).padStart(5)}`);

// ============================================================================
// TOOL-RESULTS — le second poste de coût, et le plus gros gain de ce lot.
//
// Un tool-result n'est pas payé une fois : il entre dans l'historique et est
// réémis à chaque aller-retour suivant, au même titre que le préfixe.
// On compare, sur le MÊME jeu d'essai, la forme non projetée d'origine
// (`{ employee, progress, tasks }` brut, tâches non bornées) et la forme
// actuelle.
// ============================================================================

const { InMemoryEmployeeRepository } = await import(`${R}/features/employee/infrastructure/repositories/in-memory-employee.repository`);
const { InMemoryTaskRepository } = await import(`${R}/features/employee/infrastructure/repositories/in-memory-task.repository`);
const { InMemoryOnboardingRepository } = await import(`${R}/features/onboarding/infrastructure/repositories/in-memory-onboarding.repository`);
const { makeGetEmployeeProfile } = await import(`${R}/features/employee/application/tools/get-employee-profile`);

const EMP = '11111111-1111-4111-8111-111111111111';
const employeeRow = {
  id: EMP, firstName: 'Karyl', lastName: 'SOUMAILA', email: 'karylsoumaila1@gmail.com',
  department: 'Engineering', position: 'Software Engineer', startDate: '2026-09-01T00:00:00.000Z',
  status: 'pending', managerId: null,
  createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
};
const progressRow = {
  id: '22222222-2222-4222-8222-222222222222', employeeId: EMP, status: 'in_progress',
  currentStep: 3, totalSteps: 8, startedAt: '2026-08-10T00:00:00.000Z', completedAt: null,
  createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
};
const taskRow = (i: number) => ({
  id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, employeeId: EMP,
  assigneeId: null, reviewerId: null, title: `Tâche d'intégration n°${i}`,
  description: 'Description longue et verbeuse de la tâche, rédigée pour le tableau de bord RH et sans aucune utilité pour le modèle.',
  type: 'onboarding', status: 'pending', priority: 'medium',
  dueDate: '2026-09-15T00:00:00.000Z', startedAt: null, completedAt: null, deletedAt: null,
  tags: ['onboarding', 'rh', 'j1'], metadata: { note: 'confidentiel', internalTicket: 'OPS-4821' },
  version: 1, estimatedHours: 2.5, actualHours: null,
  createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
});

const empRepo = new InMemoryEmployeeRepository();
const onbRepo = new InMemoryOnboardingRepository();
const tskRepo = new InMemoryTaskRepository();
await empRepo.save(employeeRow as never);
await onbRepo.save(progressRow as never);
const NB_TASKS = 12;
for (let i = 1; i <= NB_TASKS; i++) await tskRepo.save(taskRow(i) as never);

// Forme d'ORIGINE : l'objet du repository tel quel, tâches non bornées.
const avant = JSON.stringify({
  employee: employeeRow, progress: progressRow,
  tasks: Array.from({ length: NB_TASKS }, (_, i) => taskRow(i + 1)),
});
const apres = JSON.stringify(
  await makeGetEmployeeProfile(empRepo, onbRepo, tskRepo).execute!({ employeeId: EMP } as never, {} as never),
);

console.log(`\n=== TOOL-RESULT getEmployeeProfile (${NB_TASKS} tâches en base) ===`);
console.log(`  ${'avant (non projeté)'.padEnd(24)} ${String(tok(avant)).padStart(5)} tokens  (${avant.length} caractères)`);
console.log(`  ${'après (projeté, borné)'.padEnd(24)} ${String(tok(apres)).padStart(5)} tokens  (${apres.length} caractères)`);
console.log(`  ${'gain'.padEnd(24)} ${String(tok(avant) - tok(apres)).padStart(5)} tokens par appel`);
