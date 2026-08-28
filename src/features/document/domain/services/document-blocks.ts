export type DocumentBlock =
  | { kind: 'heading'; text: string; level: 1 | 2 }
  | { kind: 'paragraph'; text: string; italic?: boolean }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'fields'; rows: ReadonlyArray<readonly [string, string]> };

export interface DocumentOutline {
  title: string;
  blocks: DocumentBlock[];
}
