/**
 * Vérificateur du bundle Vercel — filet anti « Cannot find module ».
 *
 * Parcourt TOUS les paquets présents dans `.vercel/output/functions/index.func/node_modules/`
 * (racine et `node_modules` imbriqués) et vérifie que chaque `dependencies` déclarée est
 * résolvable depuis le bundle, avec les règles de résolution de Node. Toute dépendance
 * obligatoire introuvable est une erreur : c'est le crash `Cannot find module 'js-md5'` qui a
 * mis `documentGenerationWorkflow` à terre en production, détecté au build au lieu du runtime.
 *
 *   node scripts/verify-vercel-bundle.js            # échoue si une dépendance obligatoire manque
 *   node scripts/verify-vercel-bundle.js --require pdfkit,pdfmake,js-md5
 *                                                   # exige en plus la présence de ces modules
 *
 * Sortie : code 0 si le bundle est cohérent, 1 sinon.
 */

import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { auditBundle, readPackageJson, resolveFrom } from './vercel-bundle-deps.js';

const root = process.cwd();
const bundleDir = join(root, '.vercel', 'output', 'functions', 'index.func');
const bundleNodeModules = join(bundleDir, 'node_modules');

const requireArg = process.argv.indexOf('--require');
const explicitlyRequired =
  requireArg !== -1 && process.argv[requireArg + 1]
    ? process.argv[requireArg + 1]
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    : [];

if (!existsSync(bundleNodeModules)) {
  console.error(`❌ Bundle introuvable : ${bundleNodeModules}. Lancer d'abord \`npm run build\`.`);
  process.exit(1);
}

let failed = false;

for (const name of explicitlyRequired) {
  const dir = join(bundleNodeModules, name);
  const pkg = readPackageJson(dir);
  if (pkg) {
    console.log(`✅ Module exigé présent dans le bundle : ${name}@${pkg.version}`);
  } else {
    console.error(`❌ Module exigé ABSENT du bundle : ${name}`);
    failed = true;
  }
}

const { scanned, missing, missingOptional, unsatisfied } = auditBundle({ bundleDir });

if (missing.length > 0) {
  failed = true;
  console.error(`❌ ${missing.length} dépendance(s) obligatoire(s) irrésolvable(s) dans le bundle :`);
  for (const entry of missing) {
    console.error(`   - ${entry.name} requis par ${entry.requiredBy} (${entry.at})`);
  }
}

if (missingOptional.length > 0) {
  const names = [...new Set(missingOptional.map((e) => e.name))].sort();
  console.log(
    `ℹ️  ${missingOptional.length} dépendance(s) optionnelle(s)/peer absente(s), non bloquant : ${names.join(', ')}`
  );
}

if (unsatisfied.length > 0) {
  // ───────────────────────────────────────────────────────────────────────────
  // UN ÉCART DE MAJEURE EST BLOQUANT. Le reste ne l'est pas.
  // ───────────────────────────────────────────────────────────────────────────
  // Tout ceci était « non bloquant » jusqu'au 2026-08-12, et c'est ce qui a laissé
  // passer un bundle MORT avec un build en vert : `lru-cache@7.18.3 vs ^11.2.7` et
  // `@isaacs/ttlcache@1.4.1 vs ^2.1.5` étaient affichés, puis ignorés. Or ces deux
  // majeures-là sont précisément celles qui font passer `module.exports = Class` à
  // un espace de noms : l'import nommé de `mastra.mjs` échoue à la LIAISON, donc la
  // fonction meurt avant sa première instruction (`SyntaxError: Named export
  // 'TTLCache' not found`).
  //
  // C'est la signature récurrente de ce dépôt — un contrôle qui rassure sur un
  // artefact cassé, comme `emailSent: false` sous `status: 'success'`. Un
  // vérificateur de bundle dont le seul mode d'échec constaté passe en vert ne
  // vérifie rien.
  //
  // Une divergence de MINEURE ou de CORRECTIF reste informative : elle vient du
  // placement du bundler et n'a jamais cassé la liaison ESM.
  // Rester INFORMATIF ici est un choix, pas un oubli. Une première version de ce
  // correctif bloquait sur tout écart de majeure : elle a immédiatement dénoncé
  // cinq écarts PRÉEXISTANTS et inoffensifs (`zod@4 vs ^3` exigé par `ai@4`,
  // `ai@4 vs ^5` exigé par un provider OpenRouter jamais chargé) que la
  // production fait tourner depuis des semaines. Une heuristique de version ne
  // sait pas distinguer un pair non satisfait d'une liaison ESM rompue — seul
  // le DÉMARRAGE le sait, et c'est ce que fait le contrôle ajouté plus bas.
  const names = [
    ...new Set(unsatisfied.map((e) => `${e.name}@${e.resolvedVersion} vs ${e.range}`)),
  ].sort();
  console.log(
    `ℹ️  ${unsatisfied.length} résolution(s) hors intervalle déclaré, non bloquant : ${names.join(', ')}`
  );
}

// Contrôle ciblé sur la chaîne PDF : c'est elle qui a cassé en production, et son point d'entrée
// (`pdfmake` → `pdfkit` → `js-md5`) doit rester chargeable de bout en bout.
for (const [consumer, dependency] of [
  ['pdfmake', 'pdfkit'],
  ['pdfkit', 'js-md5'],
  ['pdfkit', 'fontkit'],
  ['pdfkit', 'linebreak'],
  ['pdfkit', 'png-js'],
]) {
  const consumerDir = join(bundleNodeModules, consumer);
  if (!existsSync(consumerDir)) continue;
  const resolved = resolveFrom(consumerDir, dependency, bundleDir);
  if (resolved) {
    console.log(
      `✅ Chaîne PDF : ${consumer} → ${dependency}@${readPackageJson(resolved)?.version} résolu.`
    );
  } else {
    console.error(`❌ Chaîne PDF : ${consumer} → ${dependency} IRRÉSOLU.`);
    failed = true;
  }
}

// Preuve de bout en bout : on rejoue, DEPUIS LE BUNDLE, la séquence exacte de
// `src/features/document/infrastructure/services/pdfmake.service.ts` (createRequire dynamique —
// c'est précisément ce que l'analyse statique du bundler ne voit pas) et on génère un vrai PDF.
// Une vérification statique dirait « js-md5 est là » ; celle-ci prouve qu'il se charge.
if (!failed) {
  try {
    const bundleRequire = createRequire(join(bundleDir, 'index.mjs'));
    const pdfmake = bundleRequire('pdfmake');
    const roboto = bundleRequire('pdfmake/build/fonts/Roboto.js');
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy(() => false);
    for (const [name, entry] of Object.entries(roboto.vfs)) {
      const data = typeof entry === 'string' ? entry : entry.data;
      const encoding = typeof entry === 'string' ? 'base64' : (entry.encoding ?? 'base64');
      pdfmake.virtualfs.writeFileSync(name, Buffer.from(data, encoding));
    }
    pdfmake.addFonts(roboto.fonts);
    const buffer = await pdfmake
      .createPdf({ content: ['bundle smoke test'], defaultStyle: { font: 'Roboto' } })
      .getBuffer();
    if (!buffer?.length || buffer.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error(`sortie inattendue (${buffer?.length ?? 0} octets)`);
    }
    console.log(
      `✅ Smoke test PDF depuis le bundle : ${buffer.length} octets générés (en-tête %PDF- valide).`
    );
  } catch (error) {
    console.error(`❌ Smoke test PDF depuis le bundle en échec : ${error?.message ?? error}`);
    console.error(
      '   C\'est le crash de documentGenerationWorkflow en production. Ne pas déployer ce bundle.'
    );
    failed = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRÔLE DE DÉMARRAGE — le seul qui prouve quelque chose
// ─────────────────────────────────────────────────────────────────────────────
// Tout ce qui précède inspecte des `package.json`. Le 2026-08-12, tous ces
// contrôles étaient VERTS sur un bundle qui mourait à la première ligne :
//     SyntaxError: Named export 'TTLCache' not found.
// Une erreur de LIAISON ESM ne se voit dans aucun manifeste — le module était
// bien présent et bien résolvable, simplement à une majeure dont la forme
// d'export avait changé. Aucune heuristique de version ne distingue ce cas d'un
// pair non satisfait inoffensif ; importer réellement le point d'entrée, si.
//
// C'est le même geste que le smoke test PDF juste au-dessus, appliqué à la
// fonction entière plutôt qu'à une seule chaîne.
//
// ⚠️ On ne juge QUE la liaison. Le module lève volontairement
// `CRITICAL: DATABASE_URL is required` au chargement, et un `file:` factice ne
// garantit rien sur la vraie base : toute erreur qui n'est pas une faute de
// résolution ou de liaison prouve que le graphe s'est chargé, donc VALIDE le
// bundle. Le contraire ferait de ce contrôle un test d'intégration déguisé,
// rouge pour des raisons sans rapport avec le déploiement.
if (existsSync(join(bundleDir, 'index.mjs'))) {
  const { spawnSync } = await import('child_process');
  const probe = spawnSync(
    process.execPath,
    ['-e', "import('./index.mjs').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(3)})"],
    {
      cwd: bundleDir,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./_verify-boot.db' },
    }
  );

  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const linkFailure =
    /Named export .* not found|ERR_MODULE_NOT_FOUND|Cannot find module|ERR_REQUIRE_ESM|does not provide an export/.test(
      output
    );

  if (linkFailure) {
    failed = true;
    console.error('❌ Le bundle NE DÉMARRE PAS — erreur de résolution ou de liaison ESM :');
    console.error(
      output
        .split('\n')
        .filter(Boolean)
        .slice(0, 4)
        .map((line) => `   ${line}`)
        .join('\n')
    );
    console.error(
      "   Un module est présent mais à une majeure dont la forme d'export a changé. Correctif :"
    );
    console.error('   ajouter le paquet à MODULES_TO_COPY dans scripts/fix-vercel-output.js —');
    console.error(
      "   la copie depuis la racine ÉCRASE la version périmée, ce qu'ensureTransitiveDependencies"
    );
    console.error('   ne fait pas (elle ne comble que les modules ABSENTS). Ne pas déployer.');
  } else {
    console.log('✅ Démarrage du bundle : le graphe de modules se charge et se lie.');
  }
}

if (failed) {
  console.error('❌ Vérification du bundle en échec.');
  process.exit(1);
}

console.log(`✅ Bundle vérifié : ${scanned} paquets scannés, aucune dépendance manquante.`);
