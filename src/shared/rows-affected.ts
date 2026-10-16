import { errorMessage } from './errors';

export function affectedRowsOrThrow(result: unknown, operation: string): number {
  const node = result as { rowsAffected?: unknown; changes?: unknown } | null;

  if (typeof node?.rowsAffected === 'number' && Number.isFinite(node.rowsAffected)) {
    return node.rowsAffected;
  }
  if (typeof node?.changes === 'number' && Number.isFinite(node.changes)) {
    return node.changes;
  }

  throw new Error(
    `Le pilote n'a rendu ni \`rowsAffected\` ni \`changes\` pour ${operation} : ` +
      `impossible de savoir combien de lignes ont été touchées.`,
  );
}

export function affectedRowsOrFallback(
  result: unknown,
  operation: string,
  fallback: number,
  onUnknown: (message: string) => void,
): number {
  try {
    return affectedRowsOrThrow(result, operation);
  } catch (error) {
    onUnknown(`${errorMessage(error)} Repli déclaré : ${fallback}.`);
    return fallback;
  }
}
