/**
 * Résolution de dépendances pour le bundle Vercel.
 *
 * Contexte : le bundler Mastra/Vercel fait une analyse statique des imports et ne copie dans
 * `.vercel/output/functions/index.func/node_modules/` que ce qu'il a su tracer. Les `require()`
 * dynamiques lui échappent — c'est exactement le cas de `pdfkit`, qui fait `require('js-md5')`
 * depuis `pdfkit/js/pdfkit.js`. Résultat en production :
 *
 *   Cannot find module 'js-md5' — require stack: /var/task/node_modules/pdfkit/js/pdfkit.js
 *
 * `scripts/fix-vercel-output.js` recopiait déjà certains modules « en entier », mais recopier un
 * module ne recopie pas ses dépendances : le problème se déplaçait simplement d'un cran.
 *
 * Ce module fournit la routine générique qui manquait : partant des modules recopiés à la main,
 * elle parcourt récursivement le graphe `dependencies` et copie tout ce qui n'est pas résolvable
 * DANS le bundle. Aucune liste de noms en dur — un nouveau module transitif manquant est traité
 * automatiquement, et `auditBundle()` fait échouer le build si quoi que ce soit reste irrésolu.
 *
 * Règles de résolution : identiques à Node (remontée des `node_modules` parents, bornée à la
 * racine). Une dépendance satisfaite par un `node_modules` imbriqué (ex. `pdfkit/node_modules/
 * @noble/hashes@1.8.0`, embarqué par la copie récursive de `pdfkit`) n'est donc PAS recopiée.
 */

import { cp, mkdir, rm } from 'fs/promises';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';

/**
 * `semver` sert uniquement à savoir si une version déjà présente dans le bundle satisfait
 * l'intervalle déclaré. Il est déclaré en devDependency et arrive de toute façon comme
 * dépendance transitive de `@mastra/deployer-vercel` (donc présent même avec
 * `NODE_ENV=production`). L'import est malgré tout tolérant : si le paquet manque, on retombe
 * sur « toute version présente convient », ce qui désactive seulement l'imbrication corrective —
 * jamais la copie des modules manquants, qui est le cœur du correctif.
 */
let semver = null;
try {
  ({ default: semver } = await import('semver'));
} catch {
  console.log(
    "ℹ️  `semver` indisponible : vérification des intervalles de versions désactivée (la copie des dépendances manquantes reste active)."
  );
}

/** Profondeur d'imbrication maximale — garde-fou contre les cycles du graphe npm. */
const MAX_NESTING_DEPTH = 6;

/** Lit un package.json, ou `null` si absent/illisible. */
export function readPackageJson(packageDir) {
  const manifest = join(packageDir, 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Dépendances qu'un paquet exige au runtime.
 *
 * - `dependencies`         : obligatoires (leur absence est fatale).
 * - `optionalDependencies` : incluses, mais leur absence n'est jamais fatale.
 * - `peerDependencies`     : incluses si non marquées optionnelles — npm ne les installe plus
 *                            automatiquement, mais le `require()` correspondant reste réel.
 * - `devDependencies`      : jamais.
 */
export function declaredDependencies(pkg) {
  const required = new Set(Object.keys(pkg?.dependencies ?? {}));
  const optional = new Set(Object.keys(pkg?.optionalDependencies ?? {}));
  const peerMeta = pkg?.peerDependenciesMeta ?? {};
  for (const name of Object.keys(pkg?.peerDependencies ?? {})) {
    if (!peerMeta[name]?.optional) optional.add(name);
  }
  for (const name of required) optional.delete(name);
  return { required: [...required], optional: [...optional], all: [...required, ...optional] };
}

/**
 * Intervalle de versions déclaré pour `dep`, et nature de la déclaration.
 *
 * `peerOnly` est décisif : une peer dependency est par définition un SINGLETON partagé. En
 * imbriquer une copie créerait deux instances du même paquet — pour `zod`, cela suffit à faire
 * échouer tous les `instanceof ZodType` traversant la frontière. On ne dédouble jamais une peer.
 */
export function dependencyDeclaration(pkg, dep) {
  const own = pkg?.dependencies?.[dep] ?? pkg?.optionalDependencies?.[dep] ?? null;
  const peer = pkg?.peerDependencies?.[dep] ?? null;
  return { range: own ?? peer, peerOnly: own === null && peer !== null };
}

/**
 * `version` satisfait-elle `range` ?
 *
 * Renvoie `true` quand on ne peut pas trancher (intervalle absent, alias `npm:`, `workspace:`,
 * URL git…) : en cas de doute on ne touche à rien, la présence du paquet suffit.
 */
export function versionSatisfies(version, range) {
  if (!version || !range || !semver) return true;
  // Alias npm : `npm:@ai-sdk/provider-utils@3.0.30` → `3.0.30`
  const normalized = range.startsWith('npm:') ? range.slice(range.lastIndexOf('@') + 1) : range;
  if (!semver.validRange(normalized)) return true;
  return semver.satisfies(version, normalized, { includePrerelease: true });
}

/**
 * Résolution Node d'un nom de paquet depuis `fromDir`, en remontant les `node_modules` parents.
 * `boundary` est le répertoire racine de l'arbre (celui qui *contient* le `node_modules` de plus
 * haut niveau) : la remontée s'y arrête, on ne sort jamais du bundle ni du projet.
 *
 * @returns {string|null} répertoire du paquet résolu
 */
export function resolveFrom(fromDir, name, boundary) {
  let current = fromDir;
  for (;;) {
    if (current.endsWith(`${sep}node_modules`)) {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(current);
    if (current === boundary || parent === current) return null;
    current = parent;
  }
}

/** Énumère les paquets présents sous un `node_modules` (gère les scopes `@x/y`). */
export function listPackages(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) return [];
  const found = [];
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    const dir = join(nodeModulesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(dir)) {
        if (scoped.startsWith('.')) continue;
        const scopedDir = join(dir, scoped);
        if (statSync(scopedDir).isDirectory() && existsSync(join(scopedDir, 'package.json'))) {
          found.push({ name: `${entry}/${scoped}`, dir: scopedDir });
        }
      }
      continue;
    }
    if (existsSync(join(dir, 'package.json'))) found.push({ name: entry, dir });
  }
  return found;
}

/**
 * Complète le bundle avec la fermeture transitive des `seeds`.
 *
 * Parcours en largeur piloté par le BUNDLE (et non par le `node_modules` source) : pour chaque
 * paquet déjà dans le bundle on tente de résoudre chacune de ses dépendances *dans le bundle*.
 *   - résolue      → rien à copier, on continue le parcours à l'intérieur ;
 *   - non résolue  → copie depuis l'arbre source, à la racine du bundle si le nom y est libre,
 *                    sinon imbriquée sous le consommateur ;
 *   - hors          → une version différente de celle installée en local n'est un problème que si
 *     intervalle     elle ne satisfait pas l'intervalle semver déclaré. Dans ce cas, et
 *                    uniquement sur un paquet que NOUS venons d'ajouter, on imbrique la version
 *                    de l'arbre source : imbriquer sous un paquet neuf ne peut rien casser
 *                    d'existant, alors que le laisser charger une version hors intervalle, si.
 *                    Jamais pour une peer dependency (singleton partagé) ni pour un paquet
 *                    préexistant placé par le bundler : ces cas sont seulement signalés.
 *
 * @returns {Promise<{copied: Array, divergences: Array, unresolved: Array, visited: number}>}
 */
export async function ensureTransitiveDependencies({ projectRoot, bundleDir, seeds, log }) {
  const sourceNodeModules = join(projectRoot, 'node_modules');
  const bundleNodeModules = join(bundleDir, 'node_modules');
  const emit = log ?? (() => {});

  const copied = [];
  const divergences = [];
  const unresolved = [];
  const visited = new Set();

  /** @type {Array<{name:string,bundlePkgDir:string,sourcePkgDir:string|null,isNew:boolean}>} */
  const queue = [];
  let cursor = 0;

  for (const name of seeds) {
    const bundlePkgDir = join(bundleNodeModules, name);
    if (!existsSync(join(bundlePkgDir, 'package.json'))) continue;
    queue.push({ name, bundlePkgDir, sourcePkgDir: join(sourceNodeModules, name), isNew: false });
  }

  while (cursor < queue.length) {
    const item = queue[cursor++];
    if (visited.has(item.bundlePkgDir)) continue;
    visited.add(item.bundlePkgDir);

    // On lit le manifeste tel qu'il sera chargé au runtime : celui du bundle.
    const pkg = readPackageJson(item.bundlePkgDir);
    if (!pkg) continue;
    const { required, all } = declaredDependencies(pkg);
    const isRequired = new Set(required);

    for (const dep of all) {
      const inBundle = resolveFrom(item.bundlePkgDir, dep, bundleDir);

      // Où ce même `require(dep)` atterrit-il dans l'arbre source ? C'est la version de
      // référence : celle que npm a installée et contre laquelle le paquet fonctionne.
      const source =
        (item.sourcePkgDir ? resolveFrom(item.sourcePkgDir, dep, projectRoot) : null) ??
        rootSource(sourceNodeModules, dep);

      const { range, peerOnly } = dependencyDeclaration(pkg, dep);

      if (inBundle) {
        const bundleVersion = readPackageJson(inBundle)?.version;
        const sourceVersion = source ? readPackageJson(source)?.version : undefined;

        // Une version différente de celle installée en local n'est PAS un problème tant qu'elle
        // satisfait l'intervalle déclaré : c'est le déduplicage normal de npm.
        if (versionSatisfies(bundleVersion, range)) {
          queue.push({ name: dep, bundlePkgDir: inBundle, sourcePkgDir: source, isNew: false });
          continue;
        }

        const canNest =
          item.isNew &&
          !peerOnly &&
          source &&
          versionSatisfies(sourceVersion, range) &&
          nestingDepth(item.bundlePkgDir) < MAX_NESTING_DEPTH;

        if (canNest) {
          // Paquet que NOUS venons d'ajouter : lui imbriquer la version de l'arbre source ne
          // peut rien casser d'existant (personne d'autre ne résout à travers lui), alors que
          // le laisser récupérer une version hors intervalle, si.
          const nested = join(item.bundlePkgDir, 'node_modules', dep);
          await copyPackage(source, nested);
          copied.push({
            name: dep,
            version: sourceVersion,
            reason: 'version',
            location: relative(bundleNodeModules, nested),
            requiredBy: item.name,
          });
          emit(
            `✅ Patch appliqué : module ${dep}@${sourceVersion} copié manuellement en entier ` +
              `(imbriqué sous ${item.name} ; la racine du bundle expose ${bundleVersion}, ` +
              `hors de l'intervalle ${range}).`
          );
          queue.push({ name: dep, bundlePkgDir: nested, sourcePkgDir: source, isNew: true });
          continue;
        }

        // Paquet préexistant placé par le bundler (et qui tourne aujourd'hui en production) ou
        // peer dependency : on ne modifie pas sa résolution, on signale.
        divergences.push({
          name: dep,
          requiredBy: item.name,
          bundleVersion,
          sourceVersion,
          range,
          peerOnly,
        });
        queue.push({ name: dep, bundlePkgDir: inBundle, sourcePkgDir: source, isNew: false });
        continue;
      }

      // Introuvable dans le bundle : c'est exactement le bug `Cannot find module`.
      if (!source) {
        // Absente aussi de l'arbre source : dépendance optionnelle non installée (binaire
        // spécifique à une plateforme, par exemple). Rien à copier, mais on la trace.
        unresolved.push({ name: dep, requiredBy: item.name, optional: !isRequired.has(dep) });
        continue;
      }

      const rootSlot = join(bundleNodeModules, dep);
      const nestingAllowed = nestingDepth(item.bundlePkgDir) < MAX_NESTING_DEPTH;
      if (existsSync(rootSlot) && !nestingAllowed) {
        unresolved.push({ name: dep, requiredBy: item.name, optional: !isRequired.has(dep) });
        continue;
      }
      const destination = existsSync(rootSlot)
        ? join(item.bundlePkgDir, 'node_modules', dep)
        : rootSlot;
      const version = readPackageJson(source)?.version;
      await copyPackage(source, destination);
      copied.push({
        name: dep,
        version,
        reason: 'missing',
        location: relative(bundleNodeModules, destination),
        requiredBy: item.name,
      });
      emit(
        `✅ Patch appliqué : module ${dep}@${version} copié manuellement en entier ` +
          `(dépendance transitive de ${item.name}, absente du bundle).`
      );
      queue.push({ name: dep, bundlePkgDir: destination, sourcePkgDir: source, isNew: true });
    }
  }

  return { copied, divergences, unresolved, visited: visited.size };
}

/**
 * Contrôle a posteriori : pour CHAQUE paquet présent dans le bundle (racine et imbriqués),
 * chaque dépendance déclarée doit être résolvable depuis le bundle lui-même.
 *
 * C'est la garantie anti-régression : plus aucun `Cannot find module` ne peut franchir le build
 * silencieusement, quel que soit le module concerné.
 *
 * @returns {{scanned:number, missing:Array, missingOptional:Array, unsatisfied:Array}}
 */
export function auditBundle({ bundleDir }) {
  const bundleNodeModules = join(bundleDir, 'node_modules');
  const missing = [];
  const missingOptional = [];
  const unsatisfied = [];
  const seen = new Set();
  let scanned = 0;

  const walk = (nodeModulesDir) => {
    for (const { name, dir } of listPackages(nodeModulesDir)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      scanned += 1;
      const pkg = readPackageJson(dir);
      if (pkg) {
        const { required, all } = declaredDependencies(pkg);
        const isRequired = new Set(required);
        for (const dep of all) {
          const resolved = resolveFrom(dir, dep, bundleDir);
          if (!resolved) {
            (isRequired.has(dep) ? missing : missingOptional).push({
              name: dep,
              requiredBy: `${name}@${pkg.version ?? '?'}`,
              at: relative(bundleNodeModules, dir),
            });
            continue;
          }
          const { range, peerOnly } = dependencyDeclaration(pkg, dep);
          const resolvedVersion = readPackageJson(resolved)?.version;
          if (!versionSatisfies(resolvedVersion, range)) {
            unsatisfied.push({
              name: dep,
              requiredBy: `${name}@${pkg.version ?? '?'}`,
              resolvedVersion,
              range,
              peerOnly,
            });
          }
        }
      }
      const nested = join(dir, 'node_modules');
      if (existsSync(nested)) walk(nested);
    }
  };

  walk(bundleNodeModules);
  return { scanned, missing, missingOptional, unsatisfied };
}

/** Nombre de niveaux `node_modules` traversés — sert de garde-fou anti-cycle. */
function nestingDepth(packageDir) {
  return packageDir.split(`${sep}node_modules${sep}`).length - 1;
}

/** Dernier recours quand on ignore d'où vient un paquet du bundle : la racine du projet. */
function rootSource(sourceNodeModules, name) {
  const candidate = join(sourceNodeModules, name);
  return existsSync(join(candidate, 'package.json')) ? candidate : null;
}

/** Copie idempotente : destination déjà au bon nom/version ⇒ aucune écriture. */
async function copyPackage(source, destination) {
  const current = readPackageJson(destination);
  const wanted = readPackageJson(source);
  if (current && wanted && current.name === wanted.name && current.version === wanted.version) {
    return false;
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false });
  return true;
}
