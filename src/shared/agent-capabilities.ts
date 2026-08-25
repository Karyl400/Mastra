export const AGENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  onboardingOrchestrator: [
    'findEmployeeByEmail',
    'findPersonByName',
    'getEmployeeProfile',
    'updateOnboardingStatus',
    'generateDocument',
    'findExpertise',
  ],
  notificationAgent: [
    'findEmployeeByEmail',
    'findPersonByName',
    'sendNotification',
    'scheduleReminder',
    'getNotificationHistory',
    'getEmployeeProfile',
    'findExpertise',
  ],
  knowledgeAgent: [
    'searchKnowledge',
    'getUserConversations',
    'getChannelHistory',
    'findExpertise',
    'findPersonByName',
  ],
  recruitmentAgent: ['scheduleCandidateInterview'],
};

export type ToolEffect = 'read' | 'write';

export const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  findEmployeeByEmail: 'read',
  findPersonByName: 'read',
  getEmployeeProfile: 'read',
  findExpertise: 'read',
  getChannelHistory: 'read',
  getUserConversations: 'read',
  searchKnowledge: 'read',
  getNotificationHistory: 'read',

  generateDocument: 'write',
  sendNotification: 'write',
  scheduleReminder: 'write',
  updateOnboardingStatus: 'write',
  scheduleCandidateInterview: 'write',
};

export function agentHasTool(agentId: string, toolName: string): boolean {
  if (!Object.hasOwn(AGENT_TOOLS, agentId)) return false;
  return AGENT_TOOLS[agentId].includes(toolName);
}

export function allWiredTools(): readonly string[] {
  return [...new Set(Object.values(AGENT_TOOLS).flat())].sort();
}

export function toolsWithEffect(effect: ToolEffect): readonly string[] {
  return allWiredTools().filter((name) => TOOL_EFFECTS[name] === effect);
}

export function isActingTool(toolName: string): boolean {
  return TOOL_EFFECTS[toolName] !== 'read';
}
