import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `.env.example` est DÉRIVÉ de `src/`, il n'est pas tenu à la main
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Onze variables lues par `src/` n'y figuraient pas — dont `AUTHZ_ENFORCE`, l'interrupteur
 * qui décide si la frontière d'autorisation refuse RÉELLEMENT. Quiconque provisionnait depuis
 * cet exemple obtenait une frontière inactive, et le symptôme d'une frontière inactive est
 * qu'elle ne se manifeste pas : tout marche, un peu trop bien.
 *
 * C'est le même défaut que ce dépôt a déjà payé trois fois ailleurs (`AGENT_TOOLS`,
 * `DETERMINISTIC_REPLIES`, `READ_ONLY_TOOL_NAMES`) : **une liste écrite à la main se
 * désynchronise au premier ajout, en silence**. La discipline du dépôt est de DÉRIVER ses
 * listes. Ce test l'applique à la liste des variables d'environnement.
 *
 * Deux sens, et ils n'ont pas le même statut :
 *
 * - SENS DUR — toute variable lue par `process.env.X` dans `src/` doit être DÉCLARÉE dans
 *   `.env.example`. C'est le sens qui a coûté quelque chose.
 *
 * - SENS SOUPLE — toute variable déclarée dans `.env.example` doit être NOMMÉE quelque part
 *   dans `src/`, `scripts/` ou `tests/`. Il ne cherche pas `process.env.X` : `MASTRA_API_TOKEN`
 *   est lu par indirection (`API_TOKEN_ENV_VAR = 'MASTRA_API_TOKEN'` dans
 *   `src/shared/security/api-auth.ts`), et exiger la forme littérale ferait rougir un test sur
 *   du code parfaitement vivant. Ce qu'il attrape, ce sont les variables que PLUS PERSONNE ne
 *   nomme : `OPENAI_API_KEY` et `AWS_SECRET_ID` ont survécu à la suppression de `src/config/`.
 */

const ROOT = resolve(__dirname, '../../..');

/**
 * Injectées par la PLATEFORME, jamais par un opérateur. Les déclarer dans `.env.example`
 * inviterait à poser `VERCEL=` en local, ce qui ferait croire au code applicatif qu'il tourne
 * sur Vercel — `scheduleBackgroundWork` en dépend.
 */
const PLATFORM_INJECTED = new Set(['VERCEL', 'VERCEL_PROJECT_PRODUCTION_URL']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|mjs|js)$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * ⚠️ Ce fichier-ci est EXCLU des sources scannées. Son propre docblock nomme les variables
 * mortes qu'il est censé dénoncer : sans cette exclusion, le sens souple se satisfait de
 * lui-même et ne peut plus rien attraper. Constaté au premier run — il passait au vert alors
 * que `OPENAI_API_KEY` et `AWS_SECRET_ID` étaient bel et bien orphelines.
 */
function readAll(dirs: string[]): string {
  return dirs
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => f !== __filename)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

/** Variables réellement lues par le code applicatif, dans les deux formes d'accès. */
function envVarsReadIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1]);
  for (const m of source.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g))
    found.add(m[1]);
  return found;
}

/** Clés DÉCLARÉES dans `.env.example` — `KEY=` en début de ligne, jamais un commentaire. */
function declaredInEnvExample(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) found.add(m[1]);
  return found;
}

const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
const declared = declaredInEnvExample(envExample);
const readInSrc = envVarsReadIn(readAll(['src']));
const allSources = readAll(['src', 'scripts', 'tests']);

describe('.env.example', () => {
  it('déclare au moins une variable (le test lit bien quelque chose)', () => {
    expect(declared.size).toBeGreaterThan(10);
    expect(readInSrc.size).toBeGreaterThan(10);
  });

  it('déclare TOUTE variable lue par process.env dans src/', () => {
    const missing = [...readInSrc]
      .filter((name) => !PLATFORM_INJECTED.has(name))
      .filter((name) => !declared.has(name))
      .sort();

    expect(
      missing,
      `Variables lues par src/ mais absentes de .env.example : ${missing.join(', ')}. ` +
        'Les ajouter — sans valeur réelle. Une variable non documentée est une variable ' +
        'que personne ne posera, et son absence ne produit aucun signal.',
    ).toEqual([]);
  });

  it('déclare AUTHZ_ENFORCE — la frontière est inactive sans elle', () => {
    expect(declared.has('AUTHZ_ENFORCE')).toBe(true);
  });

  it('déclare les identifiants de modèle, qui remplacent un modèle mort sans redéployer', () => {
    expect(declared.has('GROQ_MODEL_ID')).toBe(true);
    expect(declared.has('MISTRAL_MODEL_ID')).toBe(true);
  });

  it('ne déclare aucune variable que plus aucun code ne nomme', () => {
    const orphans = [...declared].filter((name) => !allSources.includes(name)).sort();

    expect(
      orphans,
      `Variables déclarées dans .env.example et nommées nulle part dans src/, scripts/ ` +
        `ou tests/ : ${orphans.join(', ')}. Config morte — la retirer.`,
    ).toEqual([]);
  });

  it("n'expose aucune valeur réelle : pas de jeton, pas de clé, pas de mot de passe", () => {
    const suspects = envExample
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .filter((line) => /=(xox[bperas]-|sk-|sk_live|eyJ[A-Za-z0-9_-]{10,}|SG\.)/.test(line));

    expect(suspects).toEqual([]);
  });
});
