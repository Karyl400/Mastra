import { eraseContextNote, readContextNote, writeContextNote } from './request-context-values';

export const SLACK_EXCERPT_COVERAGE_KEY = 'slackExcerptCoverage';

export function writeExcerptCoverage(requestContext: unknown, coverage: string): void {
  writeContextNote(requestContext, SLACK_EXCERPT_COVERAGE_KEY, coverage);
}

export function readExcerptCoverage(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_EXCERPT_COVERAGE_KEY);
}

export const SLACK_LOAN_DELIVERED_KEY = 'slackLoanDelivered';

export function writeLoanDelivered(requestContext: unknown, capability: string): void {
  writeContextNote(requestContext, SLACK_LOAN_DELIVERED_KEY, capability);
}

export function readLoanDelivered(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_LOAN_DELIVERED_KEY);
}

export const SLACK_DOCUMENT_RECIPIENT_KEY = 'slackDocumentRecipient';

export function writeDocumentRecipient(requestContext: unknown, recipient: string): void {
  writeContextNote(requestContext, SLACK_DOCUMENT_RECIPIENT_KEY, recipient);
}

export function readDocumentRecipient(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_DOCUMENT_RECIPIENT_KEY);
}

export const SLACK_AUTHZ_NOTICE_KEY = 'slackAuthorizationNotice';

export function writeAuthorizationNotice(requestContext: unknown, notice: string): void {
  writeContextNote(requestContext, SLACK_AUTHZ_NOTICE_KEY, notice);
}

export function readAuthorizationNotice(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_AUTHZ_NOTICE_KEY);
}

export const SLACK_STEP_BLOCKED_KEY = 'slackStepBlocked';

export function writeStepBlocked(requestContext: unknown, reason: string): void {
  writeContextNote(requestContext, SLACK_STEP_BLOCKED_KEY, reason);
}

export function readStepBlocked(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_STEP_BLOCKED_KEY);
}

export function clearStepBlocked(requestContext: unknown): void {
  eraseContextNote(requestContext, SLACK_STEP_BLOCKED_KEY);
}

export const SLACK_REMINDER_DELIVERY_KEY = 'slackReminderDelivery';

export function writeReminderDelivery(requestContext: unknown, label: string): void {
  writeContextNote(requestContext, SLACK_REMINDER_DELIVERY_KEY, label);
}

export function readReminderDelivery(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_REMINDER_DELIVERY_KEY);
}
