const RUN_GUARD_TTL_MS = 10 * 60 * 1000;

const RUN_GUARD_MAX_ENTRIES = 200;

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface RunGuard {
  get<T>(key: string): T | undefined;
  remember(key: string, value: unknown): void;
}

export function makeRunGuard(now: () => number = Date.now): RunGuard {
  const entries = new Map<string, Entry>();

  const evictExpired = (at: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  };

  return {
    get<T>(key: string): T | undefined {
      const at = now();
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= at) {
        entries.delete(key);
        return undefined;
      }
      return entry.value as T;
    },

    remember(key: string, value: unknown): void {
      const at = now();
      evictExpired(at);
      while (entries.size >= RUN_GUARD_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: at + RUN_GUARD_TTL_MS });
    },
  };
}

export function buildRunKey(
  eventTs: string | undefined,
  toolId: string,
  parts: ReadonlyArray<string | null | undefined>,
): string | undefined {
  if (!eventTs) return undefined;
  return [eventTs, toolId, ...parts.map((p) => p ?? '')].join('\u0000');
}
