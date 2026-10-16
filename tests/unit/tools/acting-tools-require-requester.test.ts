import { describe, it, expect } from 'vitest';

import { toolsWithEffect } from '../../../src/shared/agent-capabilities';
import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { makeSendNotification } from '../../../src/features/notification/application/tools/send-notification';
import { makeScheduleReminder } from '../../../src/features/notification/application/tools/schedule-reminder';
import { makeUpdateOnboardingStatus } from '../../../src/features/onboarding/application/tools/update-onboarding-status';
import { makeScheduleCandidateInterview } from '../../../src/features/recruitment/application/tools/schedule-candidate-interview';
import { OnboardingStatus } from '../../../src/shared/types';

type Calls = string[];

function recorder(calls: Calls, path = 'dep'): unknown {
  return new Proxy(function () {}, {
    get: (_target, prop) =>
      typeof prop === 'symbol' || prop === 'then' ? undefined : recorder(calls, `${path}.${prop}`),
    apply: () => {
      calls.push(path);
      return undefined;
    },
  });
}

const EMPLOYEE = 'd36b78dc-a039-4160-b86a-bd3d2a722b6c';

type Built = { tool: { execute?: (input: never, ctx: never) => Promise<unknown> }; input: unknown };

const BUILDERS: Record<string, (spy: () => never) => Built> = {
  generateDocument: (spy) => ({
    tool: makeGenerateDocument({
      documentRepo: spy(),
      employeeRepo: spy(),
      renderers: [],
      fileUpload: spy(),
      emailProvider: spy(),
    }) as never,
    input: {
      employeeId: EMPLOYEE,
      type: 'guide',
      title: 'Guide',
      content: 'x',
      deliverTo: 'email',
    },
  }),
  sendNotification: (spy) => ({
    tool: makeSendNotification(spy(), spy(), spy(), spy(), spy()) as never,
    input: { recipientId: EMPLOYEE, subject: 's', body: 'b' },
  }),
  scheduleReminder: (spy) => ({
    tool: makeScheduleReminder(spy(), spy()) as never,
    input: { recipientId: EMPLOYEE, subject: 's', body: 'b', scheduledAt: '2099-01-01T09:00:00Z' },
  }),
  updateOnboardingStatus: (spy) => ({
    tool: makeUpdateOnboardingStatus(spy()) as never,
    input: { employeeId: EMPLOYEE, status: OnboardingStatus.Completed },
  }),
  scheduleCandidateInterview: (spy) => ({
    tool: makeScheduleCandidateInterview({
      chat: spy(),
      presenter: spy(),
      pending: spy(),
      directoryRepo: spy(),
    } as never) as never,
    input: { candidateEmail: 'jean@exemple.com', startsAt: '2099-01-01T09:00:00Z' },
  }),
};

describe('un outil AGISSANT exige un demandeur identifié (lot 10, audit QA 2026-08-28 §1.1)', () => {
  it('chaque outil à effet de TOOL_EFFECTS a son entrée ici — le 14ᵉ est couvert d’avance', () => {
    expect([...toolsWithEffect('write')].sort()).toEqual(Object.keys(BUILDERS).sort());
  });

  for (const name of toolsWithEffect('write')) {
    it(`${name} : sans contexte, refuse SANS toucher aucune dépendance`, async () => {
      const calls: Calls = [];
      const build = BUILDERS[name];
      expect(build, `aucune entrée pour l’outil agissant ${name}`).toBeDefined();
      const { tool, input } = build(() => recorder(calls) as never);

      const result = (await tool.execute!(input as never, {} as never)) as Record<string, unknown>;

      expect(calls).toEqual([]);
      expect(JSON.stringify(result)).toMatch(/no_requester|no_slack_context/);
    });
  }
});
