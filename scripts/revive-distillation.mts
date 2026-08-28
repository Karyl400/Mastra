/**
 * RÉANIMER LES MESSAGES MARQUÉS TRAITÉS PAR UN DÉFAUT — audit du 2026-08-28, § 1.2.
 *
 * `findPendingDistillation` rendait `channelId: undefined` (query builder en camelCase, mapper
 * écrit en snake_case). L'insert violait alors `knowledge_facts.channel_id NOT NULL`, le `catch`
 * avalait en `warn`, et `markDistilled` s'exécutait **inconditionnellement** : les messages
 * étaient marqués traités sans l'avoir été, et ne repassaient plus jamais.
 *
 * Les deux causes sont corrigées dans le code. Ce script fait le SECOND geste — celui qu'aucun
 * correctif de code ne peut faire : rendre au niveau 2 les lignes déjà perdues.
 *
 * ⚠️ **DÉMARQUER NE SUFFIT PAS À LES FAIRE REPASSER**, et il faut le dire ici parce que personne
 * ne le verra ailleurs : `runFactCurtain` ne regarde que `CURTAIN_WINDOW_MS` (6 h). Une ligne
 * démarquée dont le `posted_at` est plus vieux que six heures redevient éligible **en théorie**
 * et ne sera **jamais** sélectionnée en pratique. Ce script rapporte donc les deux nombres
 * séparément : ce qu'il a démarqué, et ce que le rideau peut réellement reprendre.
 *
 * ⚠️ Le niveau 1 n'a JAMAIS rien perdu — le texte brut est intact et `search()` le trouve. Ce
 * qui manque est la distillation, c'est-à-dire un confort de lecture, pas la donnée.
 *
 * Usage :
 *   npx tsx --env-file=.env scripts/revive-distillation.mts          (lecture seule)
 *   npx tsx --env-file=.env scripts/revive-distillation.mts --yes    (écrit)
 */
import { createClient } from '@libsql/client';

import { makeDbExec } from './lib/resilient-db';

const APPLY = process.argv.includes('--yes');
const CURTAIN_WINDOW_MS = 6 * 60 * 60 * 1000;

const db = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});
const dbExec = makeDbExec(db);

const count = async (where: string): Promise<number> =>
  Number((await dbExec(`SELECT count(*) c FROM channel_messages WHERE ${where}`)).rows[0]!.c);

const total = await count('1=1');
const marked = await count('distilled_at IS NOT NULL');
const pending = await count('distilled_at IS NULL');
const facts = Number((await dbExec('SELECT count(*) c FROM knowledge_facts')).rows[0]!.c);

// Ce que le rideau reprendra VRAIMENT : marqué, et encore dans sa fenêtre.
const reprisable = await count(
  `distilled_at IS NOT NULL AND posted_at >= ${Date.now() - CURTAIN_WINDOW_MS}`,
);

console.log(`channel_messages          : ${total}`);
console.log(`  déjà marqués distillés   : ${marked}`);
console.log(`  encore en attente        : ${pending}`);
console.log(`knowledge_facts           : ${facts}\n`);
console.log(`Démarquables               : ${marked}`);
console.log(`Dont le rideau REPRENDRA   : ${reprisable}   (fenêtre de 6 h)`);

if (marked > 0 && reprisable < marked) {
  console.log(
    `\n⚠️  ${marked - reprisable} ligne(s) sortiront du marquage sans jamais être reprises :\n` +
      `    leur posted_at dépasse la fenêtre de 6 h du rideau. Les démarquer reste juste — la\n` +
      `    marque affirmait un examen qui n'a pas eu lieu — mais ne les distillera pas.\n` +
      `    Leur texte reste intégralement lisible au niveau 1.`,
  );
}

if (!APPLY) {
  console.log('\n(lecture seule — relancer avec --yes pour écrire)');
  process.exit(0);
}

const result = await dbExec(
  'UPDATE channel_messages SET distilled_at = NULL WHERE distilled_at IS NOT NULL',
);
const affected = Number(result.rowsAffected ?? 0);

console.log(`\n✅ ${affected} ligne(s) démarquée(s).`);

const apres = await count('distilled_at IS NOT NULL');
console.log(`Relecture — encore marquées : ${apres}`);
if (apres !== 0) {
  console.error("❌ La relecture contredit l'écriture. Ne pas conclure ; vérifier à la main.");
  process.exit(1);
}
