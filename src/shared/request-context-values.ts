export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function writeContextNote(requestContext: unknown, key: string, value: string): void {
  if (!value.trim()) return;
  if (typeof requestContext !== 'object' || requestContext === null) return;

  const set = (requestContext as { set?: unknown }).set;
  if (typeof set !== 'function') return;

  try {
    (set as (this: unknown, k: string, v: unknown) => void).call(requestContext, key, value);
  } catch {}
}

export function eraseContextNote(requestContext: unknown, key: string): void {
  if (typeof requestContext !== 'object' || requestContext === null) return;

  const set = (requestContext as { set?: unknown }).set;
  if (typeof set !== 'function') return;

  try {
    (set as (this: unknown, k: string, v: unknown) => void).call(requestContext, key, '');
  } catch {}
}

export function readContextNote(requestContext: unknown, key: string): string | undefined {
  if (typeof requestContext !== 'object' || requestContext === null) return undefined;

  const get = (requestContext as { get?: unknown }).get;
  if (typeof get !== 'function') return undefined;

  try {
    return nonEmptyString((get as (this: unknown, k: string) => unknown).call(requestContext, key));
  } catch {
    return undefined;
  }
}
