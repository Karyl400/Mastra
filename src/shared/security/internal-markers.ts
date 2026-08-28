export const REDACTED_MARKER_PLACEHOLDER = '[retiré]';

const INTERNAL_MARKERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'delimiter', pattern: /kisso_[0-9a-f]{16,}/i },
  { label: 'security_marker', pattern: /\[SECURITY_BLOCK\]/i },
  { label: 'agent_identity', pattern: /KISSO-AGENT-v\d+/i },
  { label: 'directive', pattern: /\bDIRECTIVE\s+\d+\.\d+/i },

  { label: 'directives_block', pattern: /IMMUTABLE DIRECTIVES/i },
  { label: 'session_id', pattern: /\[SECURITY_ID:/i },
  { label: 'enterprise_mode', pattern: /STRICT-ENTERPRISE-MODE/i },
  { label: 'tool_firewall', pattern: /TOOL EXECUTION FIREWALL/i },
];

export function containsInternalMarkers(text: string): string[] {
  return INTERNAL_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.label,
  );
}

export const INTERNAL_MARKERS_GLOBAL = INTERNAL_MARKERS.map(({ label, pattern }) => ({
  label,
  // eslint-disable-next-line security/detect-non-literal-regexp
  pattern: new RegExp(pattern.source, `${pattern.flags}g`),
}));
