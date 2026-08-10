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
  // Non bloquant : ces placements viennent du bundler et tournent en production. Les afficher
  // évite qu'une incompatibilité de version reste invisible jusqu'au prochain incident.
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

if (failed) {
  console.error('❌ Vérification du bundle en échec.');
  process.exit(1);
}

console.log(`✅ Bundle vérifié : ${scanned} paquets scannés, aucune dépendance manquante.`);
