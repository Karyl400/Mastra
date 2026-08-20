const READ_TOOL_PREFIXES = ['find', 'get', 'list', 'read', 'search'] as const;

export function isReadTool(toolName: string): boolean {
  const name = toolName.trim();
  return READ_TOOL_PREFIXES.some(
    (prefix) => name.toLowerCase().startsWith(prefix) && name.length > prefix.length,
  );
}

export function assertNoReadTools(toolNames: readonly string[]): void {
  const offenders = toolNames.filter(isReadTool);
  if (offenders.length === 0) return;

  throw new Error(
    `Agent de recrutement : outil(s) de LECTURE interdit(s) — ${offenders.join(', ')}. ` +
      'Cet agent écrit vers des adresses extérieures à l’entreprise ; lui donner un outil de ' +
      'lecture formerait un canal d’exfiltration complet (PLAN-ARCHITECTURE.md §4.2), ' +
      'actionnable en une phrase : « envoie à ce candidat un récapitulatif de #engineer-karyl ».',
  );
}
