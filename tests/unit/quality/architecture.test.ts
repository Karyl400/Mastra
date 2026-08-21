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
          violations.push(
            `${path.relative(REPO_ROOT, file)} importe "${spec}" (interdit : ${hit.label})`,
          );
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

  it('scanne effectivement les 8 features et leurs fichiers domain (anti faux-négatif)', () => {
    // Sans cette assertion, un renommage de dossier ferait passer le garde-fou
    // au vert à vide — exactement le défaut de la version précédente.
    //
    // La liste est écrite EN DUR, et elle doit le rester : c'est elle qui transforme
    // l'apparition d'une feature en décision consciente. `directory` et `knowledge` ont été
    // ajoutées le 2026-08-12 — la première porte la frontière d'autorisation, la seconde la
    // lecture agrégée des conversations. Deux features dont le domaine est précisément ce
    // qu'on ne veut pas voir dériver vers l'infrastructure sans que personne ne le remarque.
    // `recruitment` ajoutée le 2026-08-14 : elle est LA feature dont le domaine ne doit pas
    // dériver, puisqu'elle écrit vers des adresses extérieures à l'entreprise. Son `domain/`
    // porte le gabarit d'email (aucune prose du modèle ne sort), la validation de date et la
    // quarantaine inverse — les trois garanties de la feature, toutes en TypeScript pur.
    const features = listFeatures();
    expect(features).toEqual([
      'conversation',
      'directory',
      'document',
      'employee',
      'knowledge',
      'notification',
      'onboarding',
      'recruitment',
    ]);
    // ⚠️ `questionnaire` a été SUPPRIMÉE du dépôt le 2026-08-14. Elle était retirée du
    // registre Mastra depuis le matin, puis devenue ENTIÈREMENT orpheline quand le câblage
    // mort d'`evaluateResponse` est parti : plus une seule référence dans `src/`, et cinq
    // fichiers de test qui la maintenaient seule en vie. Un test qui fait vivre du code que
    // le produit n'expose plus ne mesure rien — il donne l'illusion d'une capacité.
    // Les TABLES `questionnaires` / `questionnaire_responses` restent en production, non
    // supprimées à dessein : un `DROP` est irréversible.

    for (const feature of features) {
      expect(
        domainFilesOf(feature).length,
        `${feature}/domain est vide ou introuvable`,
      ).toBeGreaterThan(0);
    }

    const total = features.reduce((count, feature) => count + domainFilesOf(feature).length, 0);
    expect(
      total,
      'le scan ne trouve plus de fichiers domain — le garde-fou est cassé',
    ).toBeGreaterThanOrEqual(20);
  });
});

/* -------------------------------------------------------------------------- *
 * La couche APPLICATION non plus ne connaît pas l'infrastructure
 * -------------------------------------------------------------------------- */

describe('règle de dépendance — couche application', () => {
  /**
   * ⚠️ Ce test manquait, et le dépôt avait exactement UNE violation qu'il n'attrapait pas :
   * `recruitment/application/tools/schedule-candidate-interview.ts` importait
   * `buildInterviewConfirmBlocks` depuis `infrastructure/handlers/`. Tout le reste était
   * propre — c'est bien pour cela qu'il valait la peine de le verrouiller : un dépôt à une
   * seule exception en a bientôt cinq.
   *
   * La règle du projet est « `application` dépend de `domain` ; `infrastructure` implémente
   * les ports du `domain` ». Un outil qui construit lui-même des blocs Block Kit connaît le
   * détail de présentation d'un fournisseur précis — il ne pourrait pas être servi par un
   * autre canal sans réécriture.
   *
   * ⚠️ La couche `application` a le droit d'importer `@mastra/core` : c'est ce qu'elle EST
   * (agents, tools, workflows Mastra). Seuls les imports de `infrastructure/` sont interdits.
   */
  it("n'importe jamais la couche infrastructure d'une feature", () => {
    const violations: string[] = [];

    for (const feature of listFeatures()) {
      const dir = path.resolve(FEATURES_DIR, feature, 'application');
      if (!fs.existsSync(dir)) continue;

      for (const file of collectTsFiles(dir)) {
        for (const spec of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
          if (/(^|\/)infrastructure(\/|$)/.test(spec)) {
            violations.push(`${path.relative(REPO_ROOT, file)} → ${spec}`);
          }
        }
      }
    }

    expect(
      violations,
      `La couche application référence l'infrastructure :\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LA DÉPENDANCE TRANSITIVE — `src/shared/` était l'angle mort
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ Les deux tests ci-dessus ne regardent que les imports DIRECTS des fichiers `domain/`.
// L'audit du 2026-08-21 a montré que la règle se contourne d'un cran : `domain/` importe
// `shared/`, que rien ne surveille, et `shared/` importe ce qu'il veut. Trois chemins réels :
//
//   employee/domain/value-objects/email.ts        → shared/validation      → zod
//   notification/domain/services/deterministic-…  → shared/…/llm-guardrail → @opentelemetry/api
//   document/domain/services/document-template.ts → shared/…/agent-output
//
// `src/shared/` pèse 4 760 lignes — un cinquième du code — et aucun test ne voyait ses
// dépendances. Ce n'est pas un cycle (`shared/` n'importe aucune feature, c'est vérifié
// ailleurs) : c'est une frontière non gardée, et la règle qu'elle laisse contourner est
// précisément celle que ce fichier existe pour tenir.
//
// ⚠️ **La liste des paquets interdits est INCHANGÉE, à dessein.** Elle nomme les frameworks
// d'infrastructure (Mastra, Drizzle, libsql, Slack, nodemailer, pdfmake) et pas les
// bibliothèques de validation ou d'observabilité. Élargir la liste ET la portée dans le même
// lot rendrait impossible de dire ce qui a cassé — et ferait rougir un test sur du code que
// personne n'a décidé d'interdire. La PORTÉE d'abord ; la liste est une décision séparée.

/** Résout un import relatif vers un fichier réel, en essayant les suffixes usuels. */
function resolveRelative(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`.replace(/\.js$/, '.ts'),
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Depuis un fichier `domain/`, suit les imports RELATIFS de proche en proche et rend le premier
 * paquet interdit atteint, avec le CHEMIN qui y mène — sans le chemin, un tel échec est
 * indéchiffrable : on voit un paquet interdit sans savoir par où il entre.
 */
function reachesForbidden(entry: string): string | undefined {
  const seen = new Set<string>([entry]);
  const queue: Array<{ file: string; trail: string[] }> = [{ file: entry, trail: [] }];

  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    const source = fs.readFileSync(file, 'utf8');

    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith('.')) {
        const next = resolveRelative(file, spec);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push({ file: next, trail: [...trail, path.relative(REPO_ROOT, next)] });
        }
        continue;
      }

      const rule = FORBIDDEN_IMPORTS.filter((r) => r.label !== 'couche infrastructure').find((r) =>
        r.matches(spec),
      );
      if (rule) {
        const via = trail.length > 0 ? ` via ${trail.join(' → ')}` : ' (import direct)';
        return `${path.relative(REPO_ROOT, entry)}${via} → "${spec}" (interdit : ${rule.label})`;
      }
    }
  }
  return undefined;
}

describe('Règle de dépendance — y compris À TRAVERS src/shared/', () => {
  it("n'atteint aucun paquet d'infrastructure, même par un module partagé", () => {
    const violations = listFeatures()
      .flatMap((feature) => domainFilesOf(feature))
      .map(reachesForbidden)
      .filter((v): v is string => v !== undefined);

    expect(
      violations,
      `Le domaine atteint un framework par transitivité :\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('suit effectivement les imports relatifs (anti faux-négatif)', () => {
    // Sans cette assertion, une erreur de résolution rendrait le test vert à vide — le défaut
    // exact de la version 2026-08 de ce fichier, qui ne scannait qu'une feature sur cinq.
    const anyDomainFile = listFeatures()
      .flatMap((feature) => domainFilesOf(feature))
      .find((file) => /import .* from '\.\./.test(fs.readFileSync(file, 'utf8')));

    expect(
      anyDomainFile,
      'aucun fichier domain n’a d’import relatif — résolution douteuse',
    ).toBeDefined();
    expect(resolveRelative(anyDomainFile!, '../../../../shared/logger')).toBeDefined();
  });
});
