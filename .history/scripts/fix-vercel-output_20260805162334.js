import { mkdir, cp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const source = join(root, '.mastra', 'output');
const target = join(root, '.vercel', 'output');

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
    console.error('❌ Erreur: Ni .mastra/output ni .vercel/output n\'existent. Le build Mastra a échoué.');
    process.exit(1);
  }

  const funcDir = join(target, 'functions', 'index.func');
  const funcNodeModules = join(funcDir, 'node_modules');

  // 1. Patch: Copier les modules @mastra manquants/incomplets
  if (existsSync(funcNodeModules)) {
    const modulesToCopy = [
      '@mastra/core',
      '@mastra/schema-compat',
      'pdfmake',
      'pdfkit'
    ];

    for (const mod of modulesToCopy) {
      const srcMod = join(root, 'node_modules', mod);
      const dstMod = join(funcNodeModules, mod);
      if (existsSync(srcMod)) {
        await mkdir(join(dstMod, '..'), { recursive: true });
        await rm(dstMod, { recursive: true, force: true });
        await cp(srcMod, dstMod, { recursive: true });
        console.log(`✅ Patch appliqué : module ${mod} copié manuellement en entier.`);
      }
    }
  }

  // 2. Patch: Forcer Node 22 dans .vc-config.json (Mastra core v1.56 l'exige)
  const vcConfigPath = join(funcDir, '.vc-config.json');
  if (existsSync(vcConfigPath)) {
    const vcConfig = JSON.parse(await readFile(vcConfigPath, 'utf8'));
    if (vcConfig.runtime !== 'nodejs22.x') {
      vcConfig.runtime = 'nodejs22.x';
      await writeFile(vcConfigPath, JSON.stringify(vcConfig, null, 2), 'utf8');
      console.log('✅ Patch appliqué : runtime forcé à nodejs22.x dans .vc-config.json');
    }
  }
}

fixOutput();
