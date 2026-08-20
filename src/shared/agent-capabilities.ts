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
    'getUserConversations',
    'getChannelHistory',
    'findExpertise',
    'findPersonByName',
  ],
  recruitmentAgent: ['scheduleCandidateInterview'],
};

export function agentHasTool(agentId: string, toolName: string): boolean {
  if (!Object.hasOwn(AGENT_TOOLS, agentId)) return false;
  return AGENT_TOOLS[agentId].includes(toolName);
}
