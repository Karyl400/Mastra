import { mkdir, cp, rm, readFile, writeFile, readdir, stat } from 'fs/promises';
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
  // ─────────────────────────────────────────────────────────────────────────
  // Ajoutés le 2026-08-12 : SANS EUX LE BUNDLE NE DÉMARRE PAS, et le build sort
  // pourtant en vert.
  // ─────────────────────────────────────────────────────────────────────────
  // Ce ne sont pas des points d'entrée mais des dépendances transitives, ce que
  // l'en-tête ci-dessus dit précisément de ne pas lister. L'exception est
  // délibérée et tient à `ensureTransitiveDependencies` : elle comble les
  // modules ABSENTS, jamais ceux qui sont présents à une majeure PÉRIMÉE.
  //
  // Le mécanisme exact : le déployeur Mastra écrit un `package.json` de fonction
  // qui épingle `@mastra/core` en 0.24.9 et installe SA fermeture de dépendances
  // (`lru-cache@7`, `@isaacs/ttlcache@1`). Ce script écrase ensuite
  // `@mastra/core` par le vrai 1.57.0 — mais laissait sa fermeture derrière,
  // c'est-à-dire un noyau récent posé sur les dépendances d'un noyau d'il y a
  // trois majeures.
  //
  // Les deux anciennes majeures font `module.exports = Class` ; les nouvelles
  // exportent un espace de noms. `mastra.mjs` fait
  // `import { LRUCache } from 'lru-cache'` et `import { TTLCache } from
  // '@isaacs/ttlcache'` : c'est une erreur de LIAISON ESM, donc la fonction
  // entière meurt avant la première instruction. Symptôme exact :
  //     SyntaxError: Named export 'TTLCache' not found.
  //
  // ⚠️ Le vérificateur voyait l'écart (`lru-cache@7.18.3 vs ^11.2.7`) et le
  // classait « non bloquant ». C'est la signature connue de ce dépôt — un
  // contrôle vert sur un artefact mort, comme `emailSent: false` sous
  // `status: 'success'`. `verify-vercel-bundle.js` échoue désormais sur un écart
  // de MAJEURE, pour que ce mode de panne ne puisse plus repasser en silence.
  'lru-cache',
  '@isaacs/ttlcache',
];

/** Répertoire des actifs servis par le CDN, hors du bundle de la fonction. */
const staticSource = join(root, 'public');

/**
 * Actifs dont l'ABSENCE doit casser le build.
 *
 * Chacun est référencé par du code qui construit son URL sans jamais vérifier qu'il existe.
 */
const REQUIRED_STATIC_ASSETS = ['onboarding/tuto-completion-de-profil.mp4'];

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

  // 1 ter. ÉLAGAGE — le vrai levier du démarrage à froid.
  await pruneBundle(funcDir);

  // 1 quater. ÉLAGAGE PAR ATTEIGNABILITÉ — le même levier, mais au niveau des PAQUETS.
  await pruneUnreachableModules(funcDir);

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

  // 2 bis. Patch: MÉMOIRE — et ce n'est pas une question de mémoire, c'est une question de CPU.
  //
  //   ⚠️ LE DÉFAUT LE PLUS COÛTEUX DU PRODUIT, mesuré le 2026-08-18. Un POST **rejeté
  //   immédiatement** sur `/slack/events` — signature absente, donc zéro travail : pas de base,
  //   pas de Slack, pas de modèle, pas une ligne de logique métier — mettait **4,9 s puis
  //   4,8 s**. C'est le coût du DÉMARRAGE À FROID seul, c'est-à-dire du chargement du module :
  //   le graphe Mastra entier (4 agents, 12 outils, leurs schémas Zod, `docx`, `pdfmake`) est
  //   construit à l'import.
  //
  //   Or Slack accorde **3 secondes** à une interaction, et un `trigger_id` expire dans le même
  //   délai. Le budget était donc épuisé AVANT que le code ne commence. Conséquences observées
  //   en production, toutes expliquées par cette seule cause :
  //     • « Compléter mon profil » et « Parlons de toi » : la modale ne s'ouvre jamais
  //       (`trigger_id` périmé) ;
  //     • « Envoyer » et « Annuler » : Slack affiche une erreur à la personne ALORS QUE le
  //       travail aboutit — vérifié, la carte porte bien « Annulé — aucun email n'est parti ».
  //       C'est la pire combinaison, celle que ce dépôt traque partout : l'écart entre le FAIT
  //       et ce qu'en perçoit l'utilisateur ;
  //     • les rejeux `retryNum` de Slack sur `/slack/events`, qui ont rendu nécessaire la table
  //       de déduplication partagée.
  //
  //   Sur Vercel, la part de CPU allouée est PROPORTIONNELLE à la mémoire : c'est le seul
  //   levier qui agisse sur un temps de chargement de modules, et il ne demande aucun
  //   refactor. Le trafic est de ≈ 19 messages par jour, donc presque chaque clic tombe sur une
  //   instance froide — l'exception est le cas nominal.
  //
  //   ⚠️ Ce n'est PAS une solution complète, et il ne faut pas le présenter comme telle : elle
  //   réduit le temps de chargement, elle ne le supprime pas. La vraie correction est
  //   architecturale — ne rien mettre d'irrattrapable sur le chemin des 3 secondes (un bouton
  //   qui n'ouvre pas de modale n'a pas de `trigger_id` à faire expirer).
  const FUNCTION_MEMORY_MB = 3009;
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

    if (vcConfig.memory !== FUNCTION_MEMORY_MB) {
      vcConfig.memory = FUNCTION_MEMORY_MB;
      patched = true;
      console.log(
        `✅ Patch appliqué : memory=${FUNCTION_MEMORY_MB} Mo dans .vc-config.json (le CPU y est proportionnel — démarrage à froid mesuré à 4,9 s)`
      );
    }

    if (patched) {
      await writeFile(vcConfigPath, JSON.stringify(vcConfig, null, 2), 'utf8');
    }
  }

  // 3. Les actifs STATIQUES — la vidéo d'accueil.
  await publishStaticAssets();

  // 4. LE PORTIER D'ACK — la seule chose qui garantisse les 3 secondes de Slack.
  await buildSlackAckFunction();

  // 5. L'HORLOGE EXTÉRIEURE — sans elle, aucun rappel enregistré ne part jamais.
  await assertCronsAreDeployable();
}

/**
 * Vérifie que les `crons` de `vercel.json` sont DÉPLOYABLES — sans rien recopier.
 *
 * ## ⚠️ La première version les recopiait dans `config.json`, et le déploiement a ÉCHOUÉ
 *
 * ```
 * Error: A duplicated cron job with the same schedule (0 6 * * *) and
 *        path (/internal/reminders/dispatch) was found.
 * ```
 *
 * La documentation du Build Output API présente `config.json.crons` comme LA façon de déclarer
 * un cron pour cette forme de livraison. C'est vrai — mais Vercel lit AUSSI `vercel.json`, et
 * fusionne les deux sources. Écrire aux deux endroits produit un doublon, et le doublon est
 * refusé au déploiement.
 *
 * `vercel.json` est donc la source UNIQUE, et ce n'était pas déductible des docs : il a fallu
 * un déploiement rouge. La leçon est la même que partout ici — une déclaration écrite deux fois
 * finit par poser un problème, et l'on a eu de la chance que celui-ci soit bruyant.
 *
 * ## Ce qui reste utile, et qui n'a rien à voir
 *
 * Le plan Hobby REFUSE au déploiement toute expression tournant plus d'une fois par jour
 * (« Cron expressions that would run more frequently will fail during deployment »). On le
 * constate ici, au build, plutôt qu'en poussant — cinq secondes contre cinq minutes.
 *
 * ⚠️ `tests/unit/notification/reminder-dispatch-wiring.test.ts` vérifie de son côté que
 * `vercel.json` s'accorde avec les constantes du domaine — celles dont le code se sert pour
 * annoncer à quelqu'un QUAND son rappel lui reviendra. Une divergence là ne casserait rien :
 * le rappel partirait simplement à un moment différent de celui qu'on a promis.
 */
async function assertCronsAreDeployable() {
  const vercelJsonPath = join(root, 'vercel.json');
  if (!existsSync(vercelJsonPath)) return;

  const { crons } = JSON.parse(await readFile(vercelJsonPath, 'utf8'));
  if (!Array.isArray(crons) || crons.length === 0) return;

  for (const cron of crons) {
    const [minute, hour] = String(cron.schedule ?? '').split(' ');
    if (minute === '*' || hour === '*' || String(minute).includes('/') || String(hour).includes('/')) {
      console.error(
        `\u274c Planification refusée par le plan Hobby : \u00ab ${cron.schedule} \u00bb tournerait\n` +
          "   plus d'une fois par jour, et Vercel rejette le DÉPLOIEMENT dans ce cas."
      );
      process.exit(1);
    }
  }

  const configPath = join(target, 'config.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (config.crons) {
      console.error(
        "\u274c config.json déclare des crons : Vercel les FUSIONNE avec ceux de vercel.json\n" +
          '   et refuse le doublon au déploiement. La source unique est vercel.json.'
      );
      process.exit(1);
    }
  }

  console.log(
    `\u2705 Cron : ${crons.map((c) => `${c.path} @ ${c.schedule}`).join(', ')} (déclaré dans vercel.json, source unique)`
  );
}


/**
 * Construit `functions/slack-ack.func` et lui route `/slack/events` et `/slack/interactions`.
 *
 * ## Le raisonnement, en trois mesures
 *
 * Un clic de bouton SIGNÉ sur `/slack/interactions`, en production, le 2026-08-19 :
 * **5 229 ms à froid**, 684 ms à chaud, et 9 173 ms au premier appel d'un déploiement neuf.
 * Le handler ACK pourtant sans la moindre E/S, et l'import du graphe applicatif ne prend que
 * 0,82 s en local : le reste est le DÉPAQUETAGE de la fonction.
 *
 * Slack accorde 3 secondes. Le budget était donc épuisé avant la première instruction — cause
 * unique et suffisante des « boutons qui ne marchent pas », qu'aucune optimisation du handler
 * ne pouvait atteindre. À ≈ 19 messages par jour, presque chaque clic tombe sur une instance
 * froide : le cas froid EST le cas nominal.
 *
 * L'élagage a ramené la fonction de 264 à 160 Mo, ce qui aide sans garantir : 3 s est un
 * seuil, pas une moyenne. Le portier, lui, n'a AUCUNE dépendance — pas de `node_modules` du
 * tout — donc rien à dépaqueter.
 *
 * ## Pourquoi le routage doit être touché, et dans cet ordre
 *
 * La règle est posée APRÈS `{handle:'filesystem'}` : un chemin qui correspond à un actif
 * statique doit continuer d'être servi par le CDN. Et AVANT l'attrape-tout, sans quoi tout
 * continuerait d'aller à la fonction applicative.
 *
 * ⚠️ Le portier réexpédie vers `/internal/slack/…`, PAS vers le chemin d'origine : renvoyer
 * sur `/slack/…` referait matcher cette règle, donc une boucle et un bot muet.
 */
async function buildSlackAckFunction() {
  const sourceFile = join(root, 'scripts', 'slack-ack-function', 'index.mjs');
  if (!existsSync(sourceFile)) {
    console.error(`❌ Portier d'ACK introuvable : ${sourceFile}`);
    process.exit(1);
  }

  const funcDir = join(target, 'functions', 'slack-ack.func');
  await rm(funcDir, { recursive: true, force: true });
  await mkdir(funcDir, { recursive: true });
  await cp(sourceFile, join(funcDir, 'index.mjs'));

  // `"type": "module"` est OBLIGATOIRE : le lanceur Vercel lit ce manifeste pour décider
  // comment charger le point d'entrée.
  await writeFile(
    join(funcDir, 'package.json'),
    JSON.stringify({ name: 'slack-ack', type: 'module', private: true }, null, 2),
    'utf8'
  );

  // Mémoire au plancher : ce code ne fait qu'un HMAC et un `fetch`. Y mettre 3009 Mo comme la
  // fonction applicative ne gagnerait rien — le CPU proportionnel sert à charger des modules,
  // et il n'y en a aucun.
  await writeFile(
    join(funcDir, '.vc-config.json'),
    JSON.stringify(
      {
        handler: 'index.mjs',
        launcherType: 'Nodejs',
        runtime: 'nodejs22.x',
        shouldAddHelpers: true,
        // Le réacheminement est prolongé par `waitUntil` : la fonction doit rester éveillée le
        // temps que la fonction applicative réponde, démarrage à froid compris.
        maxDuration: 60,
        // ⚠️ 1769 Mo est le palier où AWS Lambda alloue UN vCPU entier, et le CPU est ce qui
        // gouverne le démarrage de Node. Ce code n'a besoin d'aucune mémoire — il fait un HMAC
        // et un `fetch` — mais le seuil de Slack est un SEUIL, pas une moyenne : le peu de
        // marge qu'on peut acheter ici se paie en millisecondes d'un compte de fonction
        // invoquée quelques fois par jour.
        memory: 1769,
      },
      null,
      2
    ),
    'utf8'
  );

  const configPath = join(target, 'config.json');
  const config = existsSync(configPath)
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : { version: 3, routes: [] };
  const routes = Array.isArray(config.routes) ? config.routes : [];

  if (!routes.some((route) => route && route.dest === '/slack-ack')) {
    const filesystemAt = routes.findIndex((route) => route && route.handle === 'filesystem');
    routes.splice(filesystemAt + 1, 0, { src: '^/slack/(events|interactions)$', dest: '/slack-ack' });
    config.routes = routes;
    await writeFile(configPath, JSON.stringify(config), 'utf8');
  }

  console.log(
    "✅ Portier d'ACK : /slack/events et /slack/interactions servis par une fonction SANS " +
      'dépendance (rejeu vers /internal/slack/…)'
  );
}

/**
 * Publie `public/` en actifs statiques Vercel, et ouvre la phase `filesystem` du routage.
 *
 * ## Pourquoi pas dans la fonction
 *
 * Un fichier posé sous `.vercel/output/static/` est servi par le CDN : il n'entre PAS dans
 * `index.func`, donc il ne pèse pas sur le dépaquetage du bundle. C'est ce qui rend acceptable
 * d'héberger 7 Mio de vidéo dans un produit dont le poste de coût numéro un est le démarrage à
 * froid (4,9 s mesurées le 2026-08-18).
 *
 * ## Pourquoi le routage doit être touché
 *
 * Le déployeur Mastra écrit `routes: [{ src: '/(.*)', dest: '/' }]` — TOUT part à la fonction,
 * y compris `/onboarding/….mp4`, qui répondrait alors 404 par la route Hono attrape-tout. La
 * phase `{ handle: 'filesystem' }` insérée en tête dit : « sers d'abord ce qui existe sur
 * disque, envoie le reste à la fonction ». Elle ne peut masquer que des chemins réellement
 * présents dans `static/`, c'est-à-dire ceux de `public/` — aucun ne commence par `/api` ni par
 * `/slack`.
 *
 * ## Pourquoi le build ÉCHOUE sur un actif manquant
 *
 * `onboarding-video.ts` DÉDUIT l'URL de la vidéo du domaine de production : plus personne ne
 * pose de variable d'environnement, donc plus personne ne remarquerait la disparition du
 * fichier. Sans ce contrôle, la supprimer produirait un lien 404 dans le premier message que
 * l'entreprise envoie à un arrivant — exactement le mode de panne silencieuse que ce dépôt
 * traque. Un build rouge est le seul endroit où cela se voit à coup sûr.
 */
async function publishStaticAssets() {
  for (const asset of REQUIRED_STATIC_ASSETS) {
    if (!existsSync(join(staticSource, asset))) {
      console.error(
        `\u274c Actif statique manquant : public/${asset}\n` +
          "   Il est cité par src/shared/onboarding-video.ts, dont l'URL est déduite du domaine\n" +
          '   de production : sans le fichier, le message d\u2019accueil pointerait vers un 404.'
      );
      process.exit(1);
    }
  }

  const staticDir = join(target, 'static');
  await rm(staticDir, { recursive: true, force: true });
  await cp(staticSource, staticDir, { recursive: true });
  console.log(`\u2705 Actifs statiques publiés : public/ \u2192 .vercel/output/static/`);

  const configPath = join(target, 'config.json');
  if (!existsSync(configPath)) return;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const routes = Array.isArray(config.routes) ? config.routes : [];
  if (routes.some((route) => route && route.handle === 'filesystem')) return;
  config.routes = [{ handle: 'filesystem' }, ...routes];
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  console.log(
    "\u2705 Routage : phase « filesystem » ouverte avant l\u2019attrape-tout (sans elle, l\u2019actif part \u00e0 la fonction)"
  );
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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ÉLAGAGE DU BUNDLE — retirer ce que Node ne chargera JAMAIS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ## La mesure qui justifie cette fonction
 *
 * Le 2026-08-18, un POST **rejeté immédiatement** sur `/slack/events` — signature absente,
 * donc zéro travail — mettait 4,9 s. Or le bundle entier s'IMPORTE en 822 ms en local : le
 * temps n'était pas dans l'exécution des modules, il était dans leur DÉBALLAGE.
 *
 *     558 Mo, 52 998 fichiers.
 *
 * Et Slack accorde 3 secondes, `trigger_id` compris. Le budget était donc dépensé avant la
 * première ligne de métier — cause unique des quatre boutons cassés.
 *
 * ⚠️ Deux fausses pistes écartées par la mesure, il faut les dire :
 *  1. `views.open` — 0,85 s contre Slack, y compris quand il échoue. Ce n'était pas ça.
 *  2. La MÉMOIRE de la fonction, portée à 3009 Mo (le CPU y est proportionnel sur Vercel) :
 *     le chaud est passé de 1,65 s à 1,0 s, mais le FROID n'a pas bougé (4,63 s / 4,70 s).
 *     C'est la preuve que le goulot n'est pas le CPU. Le réglage est conservé pour le gain
 *     à chaud, mais il ne corrige PAS ce défaut-ci et ne doit pas être présenté ainsi.
 *
 * ## Ce qu'on retire, et pourquoi c'est sûr
 *
 * Uniquement des fichiers que le runtime Node ne lit dans aucun cas :
 *  - `*.map` — 130,7 Mo à eux seuls, 11 986 fichiers. Ne servent qu'aux traces de pile d'un
 *    débogueur attaché ; aucune incidence sur l'exécution ;
 *  - `*.ts`, `*.d.ts`, `*.d.cts`, `*.tsx` — 53,4 Mo, 17 028 fichiers. Des TYPES et des
 *    sources. Le bundle exécute du `.mjs` et du `.js` : rien ici n'est résolu à l'exécution ;
 *  - `*.md` — 12,5 Mo de documentation.
 *
 * ⚠️ On ne touche à AUCUN répertoire, et c'est délibéré. Supprimer `test/` ou `src/` par leur
 * nom gagnerait ~54 Mo de plus, mais un répertoire nommé `src` ou `test` PEUT être un chemin
 * de module réellement importé (`require('pkg/src/foo')`), et l'échec serait un
 * `Cannot find module` en production — exactement le défaut `js-md5` que `healBundle` existe
 * pour ne plus jamais revoir. Le gain ne vaut pas ce risque : on ne supprime que par
 * EXTENSION, où la garantie est structurelle.
 *
 * ⚠️ `verify:bundle` tourne APRÈS cette fonction et IMPORTE réellement `index.mjs` : c'est
 * lui qui transformerait une erreur de jugement ici en build rouge plutôt qu'en panne de
 * production. Ne pas inverser cet ordre.
 */
const PRUNABLE_SUFFIXES = ['.map', '.md', '.markdown', '.ts', '.tsx', '.cts', '.mts'];

async function pruneBundle(funcDir) {
  const modulesDir = join(funcDir, 'node_modules');
  if (!existsSync(modulesDir)) return;

  let removedFiles = 0;
  let removedBytes = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // ⚠️ `.d.ts` tombe déjà sous `.ts` ; on ne teste QUE le suffixe, jamais le chemin.
      if (!PRUNABLE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      try {
        const info = await stat(full);
        await rm(full, { force: true });
        removedFiles += 1;
        removedBytes += info.size;
      } catch {
        // Un fichier qu'on n'arrive pas à retirer n'est pas un échec de build : il ne fait
        // que rester, et le bundle reste correct. On ne casse jamais un build pour un gain.
      }
    }
  }

  await walk(modulesDir);

  console.log(
    `✅ Élagage : ${removedFiles} fichiers retirés (${(removedBytes / 1048576).toFixed(1)} Mo) — ` +
      'ni sources TypeScript, ni source maps, ni documentation ne sont chargées à l’exécution'
  );
}

/**
 * Paquets résolus À L'EXÉCUTION par un nom que l'analyse statique ne peut pas voir.
 *
 * ⚠️ CETTE LISTE EST LA SEULE PARTIE ÉCRITE À LA MAIN DE L'ÉLAGAGE, et c'est le seul endroit
 * où une omission casse la production sans casser le build. Elle recouvre exactement la liste
 * que `verify:bundle --require` nomme déjà, pour la raison qui l'a fait naître : `pdfmake` est
 * chargé par `createRequire`, donc invisible à toute analyse d'imports — c'est ce qui avait
 * produit `Cannot find module 'js-md5'` en production avec un build vert.
 *
 * Les bindings `@libsql` s'y ajoutent : leur nom est composé à partir de la plateforme.
 */
const DYNAMIC_SEEDS = [
  'pdfmake',
  'pdfkit',
  'js-md5',
  'fontkit',
  'docx',
  '@libsql/client',
  '@libsql/core',
  '@libsql/linux-x64-gnu',
  '@libsql/linux-x64-musl',
];

/**
 * Proportion de paquets au-delà de laquelle on REFUSE d'élaguer.
 *
 * Garde-fou contre un bug de l'analyse elle-même : si le parcours partait de racines vides, il
 * déclarerait tout inatteignable et viderait le bundle — avec, comme d'habitude ici, un build
 * parfaitement vert. On préfère un bundle gras à un bundle mort.
 */
const MAX_PRUNE_RATIO = 0.75;

/** Toute chaîne littérale passée à `import` / `require` / `from`. */
const SPEC_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;

function packageOfSpecifier(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * ÉLAGAGE PAR ATTEIGNABILITÉ — retire les paquets qu'aucun chemin d'import n'atteint.
 *
 * ## Pourquoi, et pourquoi c'est LE levier
 *
 * Mesuré le 2026-08-19 : un clic de bouton signé sur `/slack/interactions` répondait en
 * **5,2 s à froid** et **0,7 s à chaud**, alors que le handler ACK sans la moindre E/S.
 * L'import du graphe entier ne prend que **0,82 s** en local : les ~4,4 s restantes sont le
 * téléchargement et le DÉPAQUETAGE de la fonction. Slack accorde 3 secondes — le budget était
 * donc épuisé avant la première instruction, et c'est la cause unique des boutons « qui ne
 * marchent pas ».
 *
 * La mémoire est déjà au maximum (3009 Mo, le CPU y est proportionnel). Restait la TAILLE :
 * 264 Mo et 20 447 fichiers, dont plus de la moitié qu'aucun `import` n'atteint — la fermeture
 * `dependencies` recopiée par `ensureTransitiveDependencies` est une SUR-approximation, et le
 * déployeur Mastra embarque en plus tout le nécessaire de fonctionnalités que ce produit
 * n'active pas (exporteurs OpenTelemetry, `js-tiktoken`, `date-fns`…).
 *
 * ## Pourquoi une analyse et pas une liste
 *
 * Une liste de paquets à retirer se périmerait au premier changement de dépendance, en silence
 * — c'est le mode de panne que ce dépôt traque partout (`agentToolBoundary` est dérivé de
 * `Object.keys(tools)` pour la même raison). Ici la liste est CALCULÉE à chaque build.
 *
 * ## Ce que l'analyse ne peut pas voir, et les trois filets
 *
 * Un `require()` à nom calculé est invisible. D'où `DYNAMIC_SEEDS` ci-dessus, et surtout :
 *   1. `verify:bundle` IMPORTE réellement `index.mjs` — une liaison rompue fait rougir le build ;
 *   2. il produit un vrai PDF ET un vrai DOCX depuis le bundle — les deux chaînes dynamiques ;
 *   3. `MAX_PRUNE_RATIO` refuse un élagage aberrant.
 */
async function pruneUnreachableModules(funcDir) {
  const modulesDir = join(funcDir, 'node_modules');
  if (!existsSync(modulesDir)) return;

  const specsOfDirectory = async (dir) => {
    const found = new Set();
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          // ⚠️ ON DESCEND AUSSI DANS LES `node_modules` IMBRIQUÉS, et c'est un correctif :
          // les ignorer a fait supprimer `esprima` et `sprintf-js` au premier essai. Un paquet
          // imbriqué (`gray-matter/node_modules/js-yaml`) résout ses propres dépendances EN
          // REMONTANT vers la racine ; ses imports désignent donc des paquets de premier
          // niveau, et les sauter revient à les déclarer inatteignables à tort.
          stack.push(full);
          continue;
        }
        if (entry.name === 'package.json') {
          try {
            const pkg = JSON.parse(await readFile(full, 'utf8'));
            for (const dep of Object.keys(pkg.dependencies ?? {})) found.add(dep);
          } catch {
            // Un `package.json` illisible ne doit pas casser le build : le paquet reste, au pire.
          }
          continue;
        }
        if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue;
        let text;
        try {
          text = await readFile(full, 'utf8');
        } catch {
          continue;
        }
        for (const match of text.matchAll(SPEC_PATTERN)) {
          const pkg = packageOfSpecifier(match[1]);
          if (pkg) found.add(pkg);
        }
      }
    }
    return found;
  };

  // Racines : les modules générés à la racine de la fonction (`index.mjs`, `mastra.mjs`, …).
  const roots = new Set(DYNAMIC_SEEDS);
  for (const entry of await readdir(funcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(mjs|cjs|js)$/.test(entry.name)) continue;
    const text = await readFile(join(funcDir, entry.name), 'utf8');
    for (const match of text.matchAll(SPEC_PATTERN)) {
      const pkg = packageOfSpecifier(match[1]);
      if (pkg) roots.add(pkg);
    }
  }

  const reachable = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const pkg = queue.pop();
    if (reachable.has(pkg)) continue;
    if (!existsSync(join(modulesDir, pkg))) continue;
    reachable.add(pkg);
    for (const dep of await specsOfDirectory(join(modulesDir, pkg))) {
      if (!reachable.has(dep)) queue.push(dep);
    }
  }

  const installed = [];
  for (const entry of await readdir(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(join(modulesDir, entry.name))) {
        installed.push(`${entry.name}/${scoped}`);
      }
    } else {
      installed.push(entry.name);
    }
  }

  const dead = installed.filter((pkg) => !reachable.has(pkg));
  if (dead.length === 0) {
    console.log('✅ Élagage par atteignabilité : aucun paquet inatteignable.');
    return;
  }

  if (dead.length / installed.length > MAX_PRUNE_RATIO) {
    console.log(
      `⚠️  Élagage par atteignabilité ABANDONNÉ : ${dead.length}/${installed.length} paquets ` +
        'déclarés inatteignables, ce qui est aberrant. Le bundle reste complet.'
    );
    return;
  }

  let removedBytes = 0;
  let removedFiles = 0;
  for (const pkg of dead) {
    const dir = join(modulesDir, pkg);
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else {
          removedFiles += 1;
          try {
            removedBytes += (await stat(full)).size;
          } catch {
            // Une taille illisible ne change rien à la suppression, seulement au compte affiché.
          }
        }
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  console.log(
    `✅ Élagage par atteignabilité : ${dead.length} paquets retirés ` +
      `(${removedFiles} fichiers, ${(removedBytes / 1048576).toFixed(0)} Mo) — ` +
      `${reachable.size} paquets conservés`
  );
}
