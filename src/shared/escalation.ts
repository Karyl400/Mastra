const DEFAULT_ESCALATION_NAME = 'Nazer';
const DEFAULT_ESCALATION_ROLE = 'General Manager';

export function escalationName(env: NodeJS.ProcessEnv = process.env): string {
  return env.ESCALATION_CONTACT_NAME?.trim() || DEFAULT_ESCALATION_NAME;
}

export function escalationRole(env: NodeJS.ProcessEnv = process.env): string {
  return env.ESCALATION_CONTACT_ROLE?.trim() || DEFAULT_ESCALATION_ROLE;
}

export const ESCALATION_CONTACT = `${escalationName()}, le ${escalationRole()}`;

export const ESCALATION_CONTACT_EN = `${escalationName()}, the ${escalationRole()}`;
