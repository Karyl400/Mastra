import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Garde-fou de la règle de dépendance : `domain` ne dépend de rien.
 *
 * Remplace la version précédente, qui ne scannait qu'une feature sur cinq et
 * détectait par `content.includes()` sur le texte brut — donc en échec sur un
 * commentaire contenant « infrastructure », et aveugle à un vrai import de
 * `@mastra/core`. Son second test était un placeholder assumé
 * (`// we will assert true here, and assume it passes`).
 *
 * Cette version découvre les features dynamiquement, parse les quatre formes
 * réelles de dépendance d'un module TS, et échoue en listant les coupables.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const FEATURES_DIR = path.resolve(REPO_ROOT, 'src/features');

/** Paquets et couches interdits dans `domain/` : cette couche doit rester du TypeScript pur. */
const FORBIDDEN_IMPORTS: ReadonlyArray<{ label: string; matches: (spec: string) => boolean }> = [
  { label: '@mastra/core', matches: (s) => s.startsWith('@mastra/') },
  { label: 'drizzle-orm', matches: (s) => s === 'drizzle-orm' || s.startsWith('drizzle-orm/') },
  { label: '@libsql', matches: (s) => s.startsWith('@libsql') },
  { label: '@slack/', matches: (s) => s.startsWith('@slack/') },
  { label: 'nodemailer', matches: (s) => s === 'nodemailer' || s.startsWith('nodemailer/') },
  { label: 'pdfmake', matches: (s) => s === 'pdfmake' || s.startsWith('pdfmake/') },
  { label: 'couche infrastructure', matches: (s) => /(^|\/)infrastructure(\/|$)/.test(s) },
];

/** Capture les 4 formes de dépendance d'un module TS : import/export … from, import(), require(). */
const IMPORT_RE =
  /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*export\s[^;]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function listFeatures(): string[] {
  return fs
    .readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, acc);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

function domainFilesOf(feature: string): string[] {
  const dir = path.join(FEATURES_DIR, feature, 'domain');
  return fs.existsSync(dir) ? collectTsFiles(dir) : [];
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Violations lisibles : « <fichier> importe "<spec>" (interdit : <règle>) ». */
function findViolations(predicate: (spec: string) => { label: string } | undefined): string[] {
  const violations: string[] = [];
  for (const feature of listFeatures()) {
    for (const file of domainFilesOf(feature)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        const hit = predicate(spec);
        if (hit) {
          violations.push(`${path.relative(REPO_ROOT, file)} importe "${spec}" (interdit : ${hit.label})`);
        }
      }
    }
  }
  return violations;
}

describe('Règle de dépendance — la couche domain ne dépend de rien', () => {
  it("n'importe aucun paquet d'infrastructure (mastra, drizzle, libsql, slack, nodemailer, pdfmake)", () => {
    const packageRules = FORBIDDEN_IMPORTS.filter((rule) => rule.label !== 'couche infrastructure');
    const violations = findViolations((spec) => packageRules.find((rule) => rule.matches(spec)));

    expect(
      violations,
      `Violations de la règle de dépendance dans src/features/*/domain :\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });

  it("n'importe jamais la couche infrastructure d'une feature", () => {
    const rule = FORBIDDEN_IMPORTS.find((r) => r.label === 'couche infrastructure')!;
    const violations = findViolations((spec) => (rule.matches(spec) ? rule : undefined));

    expect(
      violations,
      `Le domaine référence la couche infrastructure :\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('scanne effectivement les 5 features et leurs fichiers domain (anti faux-négatif)', () => {
    // Sans cette assertion, un renommage de dossier ferait passer le garde-fou
    // au vert à vide — exactement le défaut de la version précédente.
    const features = listFeatures();
    expect(features).toEqual(['document', 'employee', 'notification', 'onboarding', 'questionnaire']);

    for (const feature of features) {
      expect(domainFilesOf(feature).length, `${feature}/domain est vide ou introuvable`).toBeGreaterThan(0);
    }

    const total = features.reduce((count, feature) => count + domainFilesOf(feature).length, 0);
    expect(total, 'le scan ne trouve plus de fichiers domain — le garde-fou est cassé').toBeGreaterThanOrEqual(20);
  });
});
