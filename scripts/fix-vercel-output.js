import { mkdir, cp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const source = join(root, '.mastra', 'output'); // Chemin par défaut de Mastra
const target = join(root, '.vercel', 'output');  // Chemin attendu par Vercel

async function fixOutput() {
  if (existsSync(source)) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(join(root, '.vercel'), { recursive: true });
    await cp(source, target, { recursive: true });
    console.log('✅ Sortie Mastra copiée vers .vercel/output avec succès');
  } else {
    console.error('❌ Erreur: Le dossier .mastra/output n\'existe pas. Le build Mastra a échoué.');
    process.exit(1);
  }
}

fixOutput();
