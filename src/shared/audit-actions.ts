export const AUDIT_ACTIONS = {
  rateLimited: 'RATE_LIMITED',
  authzDenied: 'AUTHZ_DENIED',
  slackMessage: 'SLACK_MESSAGE',
  agentRun: 'AGENT_RUN',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AGENT_RUN_ACTION = AUDIT_ACTIONS.agentRun;
