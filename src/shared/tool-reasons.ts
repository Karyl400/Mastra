export const TOOL_REASONS = [
  'already_prepared',
  'ambiguous',
  'delivery_failed',
  'directory_unavailable',
  'document_not_found',
  'employee_not_found',
  'forbidden',
  'link_domain_not_allowed',
  'missing_identifier',
  'missing_scope',
  'no_email',
  'no_match',
  'no_onboarding_progress',
  'no_slack_context',
  'not_authorized',
  'not_persisted',
  'not_resolvable',
  'partial_search',
  'person_not_found',
  'person_not_resolved',
  'placeholder_email',
  'post_failed',
  'recipient_not_found',
  'unavailable',
] as const;

export type ToolReason = (typeof TOOL_REASONS)[number];

export const TOOL_REASON_ALIASES: Readonly<Record<string, string>> = {
  person_not_found: 'employee_not_found',
  recipient_not_found: 'employee_not_found',
  person_not_resolved: 'not_resolvable',
};

export function isToolReason(value: string): value is ToolReason {
  return (TOOL_REASONS as readonly string[]).includes(value);
}
