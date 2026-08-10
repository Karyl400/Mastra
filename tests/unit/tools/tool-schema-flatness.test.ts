/**
 * Garde-fou anti-régression : les `inputSchema` des tools Mastra DOIVENT sérialiser
 * en JSON Schema « plat ».
 *
 * Contexte — bug de production (100 % d'échec sur `createEmployee`) :
 *
 *   APICallError: tool call validation failed: parameters for tool createEmployee
 *   did not match schema: errors: [`/position`: expected object, but got string,
 *                                  `/department`: expected object, but got string]
 *
 * Cause : `z.string()....pipe(z.nativeEnum(X))` sérialise en
 * `allOf: [{...}, {...}]`. Un noeud `allOf` / `anyOf` / `oneOf` / `$ref` n'a pas de
 * `type` racine ; le validateur de tool-calls de Groq le traite alors comme un
 * `object` et rejette la string pourtant correcte envoyée par le modèle.
 *
 * C'est la 5e occurrence de cette classe de bug dans ce dépôt
 * (`z.discriminatedUnion`, regex à classes Unicode `\p{L}`, …).
 * Ce test balaie TOUS les tools, pas seulement `createEmployee`.
 */
import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from '@mastra/schema-compat/zod-to-json';

import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { makeCreateEmployee } from '../../../src/features/employee/application/tools/create-employee';
import { makeFindEmployeeByEmail } from '../../../src/features/employee/application/tools/find-employee-by-email';
import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { makeGetTaskList } from '../../../src/features/employee/application/tools/get-task-list';
import { makeDiscoverSlackWorkspace } from '../../../src/features/notification/application/tools/discover-slack-workspace';
import { makeGetNotificationHistory } from '../../../src/features/notification/application/tools/get-notification-history';
import { makeScheduleReminder } from '../../../src/features/notification/application/tools/schedule-reminder';
import { makeSendNotification } from '../../../src/features/notification/application/tools/send-notification';
import { makeUpdateOnboardingStatus } from '../../../src/features/onboarding/application/tools/update-onboarding-status';
import { makeEvaluateResponse } from '../../../src/features/questionnaire/application/tools/evaluate-response';
import { makeGenerateQuestionnaire } from '../../../src/features/questionnaire/application/tools/generate-questionnaire';

/** Dépendance factice : absorbe n'importe quel accès / appel / construction. */
const stub: any = new Proxy(function () {} as unknown as object, {
  get: () => stub,
  apply: () => stub,
  construct: () => stub,
});

type JsonNode = Record<string, unknown>;

const NON_FLAT_KEYWORDS = ['allOf', 'anyOf', 'oneOf', '$ref'] as const;

/** Retourne les chemins JSON Pointer où un mot-clé non plat apparaît. */
function findNonFlatNodes(node: unknown, path = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as JsonNode;
  const offenders: string[] = [];

  for (const keyword of NON_FLAT_KEYWORDS) {
    if (keyword in n) offenders.push(`${path || '<root>'} -> ${keyword}`);
  }

  if (n.properties && typeof n.properties === 'object') {
    for (const [prop, sub] of Object.entries(n.properties as JsonNode)) {
      offenders.push(...findNonFlatNodes(sub, `${path}/${prop}`));
    }
  }
  if (n.items) offenders.push(...findNonFlatNodes(n.items, `${path}[]`));
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(n[keyword])) {
      (n[keyword] as unknown[]).forEach((sub, i) =>
        offenders.push(...findNonFlatNodes(sub, `${path}/${keyword}[${i}]`)),
      );
    }
  }
  return offenders;
}

const tools: Array<[name: string, tool: { id?: string; inputSchema?: unknown }]> = [
  ['generateDocument', makeGenerateDocument(stub)],
  ['createEmployee', makeCreateEmployee(stub)],
  ['findEmployeeByEmail', makeFindEmployeeByEmail(stub)],
  ['getEmployeeProfile', makeGetEmployeeProfile(stub, stub, stub)],
  ['getTaskList', makeGetTaskList(stub)],
  ['discoverSlackWorkspace', makeDiscoverSlackWorkspace(stub)],
  ['getNotificationHistory', makeGetNotificationHistory(stub)],
  ['scheduleReminder', makeScheduleReminder(stub)],
  ['sendNotification', makeSendNotification(stub, stub, stub, stub, stub)],
  ['updateOnboardingStatus', makeUpdateOnboardingStatus(stub)],
  ['evaluateResponse', makeEvaluateResponse(stub, stub)],
  ['generateQuestionnaire', makeGenerateQuestionnaire(stub)],
];

describe('Tool input schemas — JSON Schema flatness (LLM tool-call compatibility)', () => {
  it.each(tools)('%s emits a flat JSON Schema (no allOf/anyOf/oneOf/$ref)', (name, tool) => {
    expect(tool.inputSchema, `${name} has no inputSchema`).toBeDefined();

    const json = zodToJsonSchema(tool.inputSchema as never) as JsonNode;
    const offenders = findNonFlatNodes(json);

    expect(
      offenders,
      `${name} inputSchema is not flat — Groq/Vercel AI SDK will reject the tool call.\n` +
        `Offending nodes: ${offenders.join(', ')}\n` +
        `Schema: ${JSON.stringify(json)}`,
    ).toEqual([]);
  });

  it('createEmployee: department stays a flat string enum', () => {
    const tool = makeCreateEmployee(stub);
    const json = zodToJsonSchema(tool.inputSchema as never) as {
      properties: Record<string, JsonNode>;
    };

    const prop = json.properties.department;
    expect(prop, 'department missing from schema').toBeDefined();
    expect(prop, 'department must not be wrapped in allOf').not.toHaveProperty('allOf');
    expect(prop.type, 'department must be a plain string').toBe('string');
    expect(Array.isArray(prop.enum), 'department must expose an enum').toBe(true);
    expect(prop.enum as string[]).toContain('Engineering');
  });

  it('createEmployee: position serialises flat as a constrained string, without enum', () => {
    // Le poste est devenu un champ libre : plus d'`enum`, mais la sérialisation
    // doit rester PLATE — c'est ce qui compte pour le validateur de tool-calls.
    // Effet de bord recherché : les 24 valeurs de l'ancienne allowlist ne sont
    // plus réinjectées à chaque aller-retour, sous le plafond Groq.
    const tool = makeCreateEmployee(stub);
    const json = zodToJsonSchema(tool.inputSchema as never) as {
      properties: Record<string, JsonNode>;
    };

    const prop = json.properties.position;
    expect(prop, 'position missing from schema').toBeDefined();
    expect(prop, 'position must not be wrapped in allOf').not.toHaveProperty('allOf');
    expect(prop, 'position must not be wrapped in anyOf').not.toHaveProperty('anyOf');
    expect(prop.type, 'position must be a plain string').toBe('string');
    expect(prop.enum, 'position must no longer expose an enum').toBeUndefined();
  });

  it('createEmployee: managerId serialises flat (nullable must not leak an anyOf)', () => {
    const tool = makeCreateEmployee(stub);
    const json = zodToJsonSchema(tool.inputSchema as never) as {
      properties: Record<string, JsonNode>;
      required?: string[];
    };

    expect(json.properties.managerId).not.toHaveProperty('anyOf');
    expect(json.properties.managerId.type).toBe('string');
    // reste optionnel
    expect(json.required ?? []).not.toContain('managerId');
  });

  it('createEmployee: the control field firstName stays a plain string', () => {
    const tool = makeCreateEmployee(stub);
    const json = zodToJsonSchema(tool.inputSchema as never) as {
      properties: Record<string, JsonNode>;
    };
    expect(json.properties.firstName.type).toBe('string');
  });
});
