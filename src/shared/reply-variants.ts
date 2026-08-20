function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function pickVariant(variants: readonly string[], seed?: string): string {
  if (variants.length === 0) throw new Error('pickVariant exige au moins une variante');
  const first = variants[0]!;
  if (!seed || variants.length === 1) return first;
  return variants[fnv1a(seed) % variants.length] ?? first;
}
