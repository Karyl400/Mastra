export const OUTBOUND_TOOL_PREFIXES: readonly string[] = [
  'send',
  'post',
  'publish',
  'upload',
  'share',
  'invite',
  'notify',
  'email',
  'schedule',
  'create',
  'generate',
  'update',
  'delete',
  'remove',
  'assign',
  'submit',
];

export function findOutboundTools(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => {
    const normalized = name.trim().toLowerCase();
    return OUTBOUND_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  });
}

export function assertNoOutboundTools(toolNames: readonly string[]): void {
  const offenders = findOutboundTools(toolNames);
  if (offenders.length === 0) return;

  throw new Error(
    `knowledgeAgent: outil(s) de sortie interdit(s) dans un agent de lecture agrégée — ` +
      `${offenders.join(', ')}. Lecture agrégée + écriture externe = canal d'exfiltration ` +
      `(PLAN-ARCHITECTURE.md §4.2). Câbler ces outils sur un autre agent.`,
  );
}
