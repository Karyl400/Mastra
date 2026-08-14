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
import { makeFindEmployeeByEmail } from '../../../src/features/employee/application/tools/find-employee-by-email';
import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { makeDiscoverSlackWorkspace } from '../../../src/features/notification/application/tools/discover-slack-workspace';
import { makeGetNotificationHistory } from '../../../src/features/notification/application/tools/get-notification-history';
import { makeScheduleReminder } from '../../../src/features/notification/application/tools/schedule-reminder';
import { makeSendNotification } from '../../../src/features/notification/application/tools/send-notification';
import { makeUpdateOnboardingStatus } from '../../../src/features/onboarding/application/tools/update-onboarding-status';

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
  ['findEmployeeByEmail', makeFindEmployeeByEmail(stub)],
  ['getEmployeeProfile', makeGetEmployeeProfile(stub, stub)],
  ['discoverSlackWorkspace', makeDiscoverSlackWorkspace(stub)],
  ['getNotificationHistory', makeGetNotificationHistory(stub)],
  ['scheduleReminder', makeScheduleReminder(stub)],
  ['sendNotification', makeSendNotification(stub, stub, stub, stub, stub)],
  ['updateOnboardingStatus', makeUpdateOnboardingStatus(stub)],
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
});

/**
 * Deuxième classe de tool INAPPELABLE, distincte de la platitude — mesurée en
 * production le 2026-08-12 sur `evaluateResponse`, à chaque message :
 *
 *   APICallError: tool call validation failed: parameters for tool evaluateResponse
 *   did not match schema: errors: [`/answers`: additionalProperties 'q2','q3','q1' not allowed]
 *
 * Cause : `z.record(z.unknown())` sérialise en `{"type":"object","additionalProperties":{}}`
 * — un objet SANS `properties`. Le validateur de tool-calls de Groq n'accepte alors
 * AUCUNE clé : le tool est structurellement impossible à appeler, quel que soit ce
 * que le modèle envoie. Le schéma est pourtant parfaitement PLAT, donc le garde-fou
 * ci-dessus le déclarait conforme.
 *
 * La règle : tout noeud `type: "object"` doit déclarer des `properties` non vides.
 * Une carte libre clé→valeur n'a pas sa place dans un schéma de tool ; la forme qui
 * marche est un tableau de paires (`[{questionId, answer}]`), dont chaque champ est
 * nommé et typé.
 *
 * ⚠️ Ce test balaie les MÊMES tools que ci-dessus. C'est le seul contrôle du dépôt
 * qui traverse `zodToJsonSchema` : les tests de tools appellent `execute()` en
 * direct et ne peuvent, par construction, détecter un tool que le fournisseur
 * refuse d'appeler.
 */
function findUnfillableObjects(node: unknown, path = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as JsonNode;
  const offenders: string[] = [];

  if (n.type === 'object') {
    const props = n.properties as Record<string, unknown> | undefined;
    if (!props || Object.keys(props).length === 0) {
      offenders.push(`${path || '<root>'} -> object sans properties`);
    }
  }

  if (n.properties && typeof n.properties === 'object') {
    for (const [prop, sub] of Object.entries(n.properties as JsonNode)) {
      offenders.push(...findUnfillableObjects(sub, `${path}/${prop}`));
    }
  }
  if (n.items) offenders.push(...findUnfillableObjects(n.items, `${path}[]`));

  return offenders;
}

describe('Tool input schemas — appelabilité (aucun objet libre sans properties)', () => {
  it.each(tools)('%s expose un schéma remplissable par le modèle', (name, tool) => {
    const json = zodToJsonSchema(tool.inputSchema as never) as JsonNode;
    const offenders = findUnfillableObjects(json);

    expect(
      offenders,
      `${name} inputSchema contient un objet sans \`properties\` — Groq rejettera ` +
        `TOUTE clé et le tool sera inappelable en production.\n` +
        `Noeuds fautifs : ${offenders.join(', ')}\n` +
        `Schéma : ${JSON.stringify(json)}`,
    ).toEqual([]);
  });
});
