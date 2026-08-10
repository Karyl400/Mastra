import { mkdir, cp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, sep } from 'path';
import { auditBundle, ensureTransitiveDependencies } from './vercel-bundle-deps.js';

const root = process.cwd();
const source = join(root, '.mastra', 'output');
const target = join(root, '.vercel', 'output');

/**
 * Modules recopiés « en entier » depuis le node_modules du projet.
 *
 * Le bundler Mastra/Vercel n'embarque que ce que son analyse statique a su tracer ; ces
 * modules-là sont chargés dynamiquement (ou tronqués à la copie) et arrivent incomplets dans la
 * fonction. Ce ne sont que des POINTS D'ENTRÉE : leurs dépendances transitives sont traitées
 * ensuite par `ensureTransitiveDependencies`, il ne faut donc rien ajouter ici pour un module
 * qui n'est qu'une dépendance d'un autre.
 *
 * (`resend` figurait ici ; l'adaptateur a été supprimé et le paquet n'est plus installé.)
 */
const MODULES_TO_COPY = [
  '@mastra/core',
  '@mastra/schema-compat',
  'pdfmake',
  'pdfkit',
  '@noble/hashes',
];

/** Nombre de passes de rattrapage si l'audit trouve encore un trou après la première. */
const MAX_HEALING_PASSES = 3;

async function fixOutput() {
  if (existsSync(source)) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(join(root, '.vercel'), { recursive: true });
    await cp(source, target, { recursive: true });
    console.log('✅ Sortie Mastra copiée vers .vercel/output avec succès');
  } else if (existsSync(target)) {
    console.log('✅ Le dossier .vercel/output existe déjà. Le VercelDeployer a fonctionné.');
  } else {
    console.error(
      "❌ Erreur: Ni .mastra/output ni .vercel/output n'existent. Le build Mastra a échoué."
    );
    process.exit(1);
  }

  const funcDir = join(target, 'functions', 'index.func');
  const funcNodeModules = join(funcDir, 'node_modules');

  // 1. Patch: Copier les modules @mastra manquants/incomplets
  if (existsSync(funcNodeModules)) {
    for (const mod of MODULES_TO_COPY) {
      const srcMod = join(root, 'node_modules', mod);
      const dstMod = join(funcNodeModules, mod);
      if (existsSync(srcMod)) {
        await mkdir(join(dstMod, '..'), { recursive: true });
        await rm(dstMod, { recursive: true, force: true });
        await cp(srcMod, dstMod, { recursive: true });
        console.log(`✅ Patch appliqué : module ${mod} copié manuellement en entier.`);
      }
    }

    // 1 bis. Patch: fermeture transitive des modules ci-dessus.
    //
    //   Recopier un module ne recopie PAS ses dépendances. `pdfkit` était bien dans le bundle,
    //   mais pas le `require('js-md5')` que fait `pdfkit/js/pdfkit.js` — d'où, en production :
    //     Cannot find module 'js-md5' … require stack: /var/task/node_modules/pdfkit/js/pdfkit.js
    //   et `documentGenerationWorkflow` mort à 100 %.
    //
    //   La routine ci-dessous parcourt récursivement le graphe `dependencies` de chaque module
    //   recopié et complète tout ce qui n'est pas résolvable dans le bundle. Générique : aucune
    //   liste de noms en dur, donc la prochaine dépendance transitive oubliée par le bundler
    //   sera embarquée sans intervention.
    await healBundle(funcDir);
  }

  // 2. Patch: Forcer Node 22 + maxDuration dans .vc-config.json
  //    - runtime  : Mastra core v1.56 exige Node 22.
  //    - maxDuration : le traitement Slack est prolongé après l'ACK via `waitUntil`
  //      (src/api/slack-events.route.ts). `waitUntil` maintient la fonction éveillée mais
  //      reste borné par maxDuration ; sans valeur explicite, une fonction Node classique
  //      retombe sur 10 s, ce qui tue un appel LLM (2 à 17 s mesurées).
  //      60 s est valide sur TOUS les plans (Hobby non-fluid plafonne à 60 s), donc sûr.
  //      `VercelDeployer` sait poser l'option (`new VercelDeployer({ maxDuration: 60 })`)
  //      mais src/mastra/index.ts n'est pas modifié ici : le patch reste local à ce script.
  const FUNCTION_MAX_DURATION_SECONDS = 60;
  const vcConfigPath = join(funcDir, '.vc-config.json');
  if (existsSync(vcConfigPath)) {
    const vcConfig = JSON.parse(await readFile(vcConfigPath, 'utf8'));
    let patched = false;

    if (vcConfig.runtime !== 'nodejs22.x') {
      vcConfig.runtime = 'nodejs22.x';
      patched = true;
      console.log('✅ Patch appliqué : runtime forcé à nodejs22.x dans .vc-config.json');
    }

    if (vcConfig.maxDuration !== FUNCTION_MAX_DURATION_SECONDS) {
      vcConfig.maxDuration = FUNCTION_MAX_DURATION_SECONDS;
      patched = true;
      console.log(
        `✅ Patch appliqué : maxDuration=${FUNCTION_MAX_DURATION_SECONDS}s dans .vc-config.json (traitement Slack via waitUntil)`
      );
    }

    if (patched) {
      await writeFile(vcConfigPath, JSON.stringify(vcConfig, null, 2), 'utf8');
    }
  }
}

/**
 * Complète le bundle, puis vérifie. Si l'audit final trouve encore une dépendance obligatoire
 * irrésolvable — un module hors de la fermeture des seeds, donc mal tracé par le bundler
 * lui-même — on relance une passe en prenant ce module comme nouveau point d'entrée. Le build
 * échoue si un trou subsiste : jamais de déploiement avec un `require` mort.
 */
async function healBundle(funcDir) {
  let seeds = MODULES_TO_COPY;

  for (let pass = 1; pass <= MAX_HEALING_PASSES; pass += 1) {
    const { copied, divergences } = await ensureTransitiveDependencies({
      projectRoot: root,
      bundleDir: funcDir,
      seeds,
      log: (message) => console.log(message),
    });

    if (pass === 1 && copied.length === 0) {
      console.log('✅ Fermeture transitive déjà complète : aucune dépendance à copier.');
    } else if (copied.length > 0) {
      console.log(
        `✅ Fermeture transitive (passe ${pass}) : ${copied.length} module(s) ajouté(s) au bundle.`
      );
    }

    if (divergences.length > 0) {
      // Non bloquant : soit une peer dependency (singleton, on ne la dédouble jamais), soit un
      // paquet placé par le bundler qui tourne déjà en production — on ne modifie pas sa
      // résolution à l'aveugle. On les expose pour qu'aucune incompatibilité ne reste invisible.
      const summary = [
        ...new Set(
          divergences.map(
            (d) => `${d.name}@${d.bundleVersion} vs ${d.range}${d.peerOnly ? ' (peer)' : ''}`
          )
        ),
      ];
      console.log(
        `ℹ️  ${summary.length} version(s) hors intervalle déclaré dans le bundle (non bloquant) : ${summary.join(', ')}`
      );
    }

    const { scanned, missing } = auditBundle({ bundleDir: funcDir });
    if (missing.length === 0) {
      console.log(
        `✅ Audit du bundle : ${scanned} paquets scannés, aucune dépendance obligatoire manquante.`
      );
      return;
    }

    console.log(
      `⚠️  Audit du bundle : ${missing.length} dépendance(s) encore irrésolvable(s), passe de rattrapage…`
    );
    const nextSeeds = [
      ...new Set(missing.map((entry) => entry.at.split(`${sep}node_modules${sep}`)[0])),
    ];
    if (nextSeeds.length === 0) break;
    seeds = nextSeeds;
  }

  const { missing } = auditBundle({ bundleDir: funcDir });
  if (missing.length > 0) {
    console.error(
      `❌ Bundle incomplet : ${missing.length} dépendance(s) obligatoire(s) introuvable(s) après ${MAX_HEALING_PASSES} passes.`
    );
    for (const entry of missing) {
      console.error(`   - ${entry.name} requis par ${entry.requiredBy} (${entry.at})`);
    }
    console.error(
      "   Ces modules provoqueraient un `Cannot find module` au runtime. Build interrompu."
    );
    process.exit(1);
  }
}

fixOutput();
