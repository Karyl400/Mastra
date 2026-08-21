import { RequestContext } from '@mastra/core/request-context';

export const SLACK_CHANNEL_KEY = 'slackChannel';
export const SLACK_THREAD_TS_KEY = 'slackThreadTs';
export const SLACK_USER_ID_KEY = 'slackUserId';
export const SLACK_EVENT_TS_KEY = 'slackEventTs';
export const SLACK_ACCESS_LEVEL_KEY = 'slackAccessLevel';
export const SLACK_EMPLOYEE_ID_KEY = 'slackEmployeeId';

export const SLACK_EXCERPT_COVERAGE_KEY = 'slackExcerptCoverage';

export function writeExcerptCoverage(requestContext: unknown, coverage: string): void {
  writeContextNote(requestContext, SLACK_EXCERPT_COVERAGE_KEY, coverage);
}

export const SLACK_DOCUMENT_RECIPIENT_KEY = 'slackDocumentRecipient';

export function writeDocumentRecipient(requestContext: unknown, recipient: string): void {
  writeContextNote(requestContext, SLACK_DOCUMENT_RECIPIENT_KEY, recipient);
}

export function readDocumentRecipient(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_DOCUMENT_RECIPIENT_KEY);
}

/**
 * ⚠️ POURQUOI UN REFUS D'AUTORISATION PASSE PAR LE CONTEXTE, ET NON PAR LE SEUL `hint`.
 *
 * Mesuré en production le 2026-08-21 : « Prépare un email d'entretien pour … » a reçu
 * « Je ne peux pas créer cette invitation. » — exact, et muet sur la RAISON. Le `hint` du tool
 * demandait pourtant de l'expliquer, et l'agent a pour instruction de le reprendre.
 *
 * C'est la CINQUIÈME consigne d'agent mesurée en échec dans ce dépôt, après la couverture des
 * extraits, la rédaction du contenu, le `recipient` d'un document et les codes internes récités
 * par Gemini. La conclusion ne change pas : une consigne est PROBABLE, le code est GARANTI.
 *
 * Un refus qui ne dit pas pourquoi est vécu comme une panne. Nommer la seule personne qui
 * détient le droit transforme un mur en information exploitable — et coûte ZÉRO token, le
 * `RequestContext` ne traversant ni le prompt ni les schémas.
 */
export const SLACK_AUTHZ_NOTICE_KEY = 'slackAuthorizationNotice';

export function writeAuthorizationNotice(requestContext: unknown, notice: string): void {
  writeContextNote(requestContext, SLACK_AUTHZ_NOTICE_KEY, notice);
}

export function readAuthorizationNotice(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_AUTHZ_NOTICE_KEY);
}

/**
 * ⚠️ **LE MOMENT DE REMISE EST NOMMÉ PAR LE CODE, jamais par le modèle** — même raison que
 * ci-dessus, et même famille de défaut.
 *
 * Le rappel part désormais pour de bon (cron quotidien, voir `reminder-dispatch.ts`), mais la
 * plateforme ne garantit qu'un passage PAR JOUR, à ±59 min. Laisser le modèle annoncer l'heure
 * demandée — « lundi 24 août à 09 h00 » — serait une précision que rien ne tient : la famille
 * exacte d'`emailSent: false` sous `status: 'success'`.
 *
 * Le tool écrit donc ici le moment RÉEL, le handler l'accole, et le modèle n'a jamais l'heure
 * dans sa fenêtre. On ne lui interdit pas de mentir : on lui retire de quoi.
 */
export const SLACK_REMINDER_DELIVERY_KEY = 'slackReminderDelivery';

export function writeReminderDelivery(requestContext: unknown, label: string): void {
  writeContextNote(requestContext, SLACK_REMINDER_DELIVERY_KEY, label);
}

export function readReminderDelivery(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_REMINDER_DELIVERY_KEY);
}

function writeContextNote(requestContext: unknown, key: string, value: string): void {
  if (!value.trim()) return;
  if (typeof requestContext !== 'object' || requestContext === null) return;

  const set = (requestContext as { set?: unknown }).set;
  if (typeof set !== 'function') return;

  try {
    (set as (this: unknown, k: string, v: unknown) => void).call(requestContext, key, value);
  } catch {}
}

function readContextNote(requestContext: unknown, key: string): string | undefined {
  if (typeof requestContext !== 'object' || requestContext === null) return undefined;

  const get = (requestContext as { get?: unknown }).get;
  if (typeof get !== 'function') return undefined;

  try {
    return nonEmptyString((get as (this: unknown, k: string) => unknown).call(requestContext, key));
  } catch {
    return undefined;
  }
}

export function readExcerptCoverage(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_EXCERPT_COVERAGE_KEY);
}

export type SlackAccessLevel = 'denied' | 'readonly' | 'full';

const ACCESS_LEVELS: ReadonlySet<string> = new Set(['denied', 'readonly', 'full']);

export interface SlackToolContext {
  channel: string;
  threadTs?: string;
  eventTs?: string;
  slackUserId?: string;
  employeeId?: string;
  accessLevel?: SlackAccessLevel;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildSlackRequestContext(context: SlackToolContext): RequestContext {
  const entries: Array<readonly [string, unknown]> = [];

  const channel = nonEmptyString(context.channel);
  if (channel) entries.push([SLACK_CHANNEL_KEY, channel]);

  const threadTs = nonEmptyString(context.threadTs);
  if (threadTs) entries.push([SLACK_THREAD_TS_KEY, threadTs]);

  const eventTs = nonEmptyString(context.eventTs);
  if (eventTs) entries.push([SLACK_EVENT_TS_KEY, eventTs]);

  const slackUserId = nonEmptyString(context.slackUserId);
  if (slackUserId) entries.push([SLACK_USER_ID_KEY, slackUserId]);

  const employeeId = nonEmptyString(context.employeeId);
  if (employeeId) entries.push([SLACK_EMPLOYEE_ID_KEY, employeeId]);

  if (context.accessLevel) entries.push([SLACK_ACCESS_LEVEL_KEY, context.accessLevel]);

  return new RequestContext(entries);
}

function mayTouchRecord(requestContext: unknown, targetEmployeeId: string | undefined | null) {
  const context = readSlackContext(requestContext);
  if (!context) return true;

  const target = nonEmptyString(targetEmployeeId);
  if (target && context.employeeId && context.employeeId === target) return true;

  return context.accessLevel === 'full';
}

export function canPerformSideEffects(
  requestContext: unknown,
  targetEmployeeId?: string | null,
): boolean {
  return mayTouchRecord(requestContext, targetEmployeeId);
}

export function canReadPersonRecord(
  requestContext: unknown,
  targetEmployeeId: string | undefined | null,
): boolean {
  return mayTouchRecord(requestContext, targetEmployeeId);
}

export function readSlackContext(requestContext: unknown): SlackToolContext | undefined {
  if (typeof requestContext !== 'object' || requestContext === null) return undefined;

  const get = (requestContext as { get?: unknown }).get;
  if (typeof get !== 'function') return undefined;

  try {
    const read = (key: string): unknown =>
      (get as (this: unknown, key: string) => unknown).call(requestContext, key);

    const channel = nonEmptyString(read(SLACK_CHANNEL_KEY));
    if (!channel) return undefined;

    const context: SlackToolContext = { channel };

    const threadTs = nonEmptyString(read(SLACK_THREAD_TS_KEY));
    if (threadTs) context.threadTs = threadTs;

    const eventTs = nonEmptyString(read(SLACK_EVENT_TS_KEY));
    if (eventTs) context.eventTs = eventTs;

    const slackUserId = nonEmptyString(read(SLACK_USER_ID_KEY));
    if (slackUserId) context.slackUserId = slackUserId;

    const employeeId = nonEmptyString(read(SLACK_EMPLOYEE_ID_KEY));
    if (employeeId) context.employeeId = employeeId;

    const accessLevel = nonEmptyString(read(SLACK_ACCESS_LEVEL_KEY));
    if (accessLevel && ACCESS_LEVELS.has(accessLevel)) {
      context.accessLevel = accessLevel as SlackAccessLevel;
    }

    return context;
  } catch {
    return undefined;
  }
}
