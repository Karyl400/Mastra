export type WorkspaceVerdict =
  | { readonly accepted: true; readonly checked: boolean }
  | { readonly accepted: false; readonly received: string; readonly expected: string };

export function judgeWorkspace(
  teamId: string | undefined | null,
  expected: string | undefined | null,
): WorkspaceVerdict {
  const want = expected?.trim();
  if (!want) return { accepted: true, checked: false };

  const got = teamId?.trim();
  if (!got) return { accepted: true, checked: true };

  if (got !== want) return { accepted: false, received: got, expected: want };
  return { accepted: true, checked: true };
}
