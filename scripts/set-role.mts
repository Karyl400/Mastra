/**
 * DÉSIGNER LE MANAGER — le seul écrivain du rôle, et il est hors du produit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi cette écriture vit dans un script et nulle part ailleurs
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `slack_directory.role` est la seule colonne de ce dépôt dont dépende une autorisation. Aucun
 * chemin exposé à un agent, ni à un humain via Slack, ne l'écrit — et cette absence est
 * délibérée :
 *
 *  • `title` (côté annuaire) et `position` (côté dossier) sont saisis par leur porteur. Une
 *    autorisation dérivée d'un champ déclaratif s'obtiendrait en le déclarant. Le relevé de
 *    production le montre bien : `title` vaut « Product Manager » sur quelqu'un qui n'est pas
 *    LE manager, et « General Manager » sur celui qui l'est. La chaîne ne peut rien décider.
 *  • Un `setRole` déclaré dans le port `DirectoryRepository` en ferait une CAPACITÉ du produit,
 *    donc quelque chose qu'un futur câblage pourrait brancher sans le relire — la situation
 *    exacte de `discoverSlackWorkspace` avant sa suppression.
 *  • `upsertFacts` ne nomme jamais cette colonne : une synchronisation Slack ne peut donc pas
 *    rétrograder le manager. Un test du contrat partagé le verrouille sur les deux
 *    implémentations.
 *
 * ── DRY-RUN PAR DÉFAUT ──────────────────────────────────────────────────────
 * Sans `--apply`, rien n'est écrit. Même contrat que `directory:sync` et `profile:invite`.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npm run role:set                                    # inventaire
 *     npm run role:set -- --email nazer@kissohq.com       # ce qui serait fait
 *     npm run role:set -- --email nazer@kissohq.com --apply
 *     npm run role:set -- --slack-user-id UMLK5P7CG --apply
 *     npm run role:set -- --email x@y.z --role employee --apply   # rétrograder
 */
import { createClient, type Row } from '@libsql/client';

import { EmployeeRole } from '../src/shared/types';

const args = process.argv.slice(2);
const at = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const apply = args.includes('--apply');
const email = at('--email')?.trim().toLowerCase();
const slackUserId = at('--slack-user-id')?.trim();
const requested = (at('--role') ?? EmployeeRole.Manager).trim().toLowerCase();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant. Lancer avec --env-file=.env');
  process.exit(1);
}

// ⚠️ Liste FERMÉE. Une valeur inconnue n'accorderait rien (`isManagerRole` est tolérant dans le
// sens sûr), mais elle laisserait une colonne d'autorisation dans un état que personne ne
// relit. On refuse à l'ÉCRITURE plutôt que de compter sur la tolérance à la LECTURE.
const VALID: readonly string[] = [EmployeeRole.Employee, EmployeeRole.Manager];
if (!VALID.includes(requested)) {
  console.error(`Rôle inconnu : « ${requested} ». Valeurs acceptées : ${VALID.join(', ')}.`);
  process.exit(1);
}

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

const nameOf = (row: Row) =>
  String(row.real_name || row.display_name || row.slack_user_id || '').trim();

// ─────────────────────────────────────────────────────────────────────────────
// INVENTAIRE — toujours affiché, y compris avant une écriture
// ─────────────────────────────────────────────────────────────────────────────
async function inventory(): Promise<void> {
  const rows = (
    await client.execute(
      `SELECT slack_user_id, real_name, display_name, email, title, role, is_deleted
         FROM slack_directory
        WHERE is_bot = 0 AND is_deleted = 0
        ORDER BY role DESC, lower(coalesce(real_name, display_name, slack_user_id))`,
    )
  ).rows;

  console.log(`\n${rows.length} personne(s) vivante(s) dans l’annuaire :\n`);
  for (const row of rows) {
    const marque = row.role === EmployeeRole.Manager ? '★' : ' ';
    console.log(
      `  ${marque} ${nameOf(row)}`.padEnd(26) +
        String(row.email ?? '(pas d’email)').padEnd(30) +
        // ⚠️ Le TITRE est affiché à côté du RÔLE pour rendre visible qu'ils sont sans rapport.
        // C'est la confusion que ce script doit rendre impossible : « Product Manager » est un
        // intitulé, `manager` est un droit.
        `titre=${String(row.title ?? '—')}`.padEnd(28) +
        `rôle=${String(row.role ?? '(null)')}`,
    );
  }

  const managers = rows.filter((r) => r.role === EmployeeRole.Manager);
  console.log(`\n  → ${managers.length} manager(s).`);

  if (managers.length === 0) {
    console.log(
      '  ⚠️ Aucun manager désigné : `SlackAccessGuard` REFUSE d’appliquer la frontière tant\n' +
        '     que c’est le cas, même avec AUTHZ_ENFORCE=true. Appliquer sans manager\n' +
        '     rétrograderait l’organisation entière.',
    );
  }
}

await inventory();

if (!email && !slackUserId) {
  console.log('\nNi `--email` ni `--slack-user-id` : inventaire seul, rien n’a été touché.\n');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// LA CIBLE — résolue AVANT d'écrire, et l'échec est BRUYANT
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ On ne fait PAS d'`UPDATE … WHERE email = ?` à l'aveugle. Un UPDATE sans ligne
// correspondante RÉUSSIT sans rien faire : le script dirait « c'est fait » sur une adresse mal
// tapée, et l'on croirait avoir désigné quelqu'un. C'est le défaut que `linkEmployee` a dû
// corriger en production le 2026-08-19, en rendant le nombre de lignes touchées.
const found = (
  slackUserId
    ? await client.execute({
        sql: `SELECT slack_user_id, real_name, display_name, email, title, role, is_deleted, is_bot
                FROM slack_directory WHERE slack_user_id = ?`,
        args: [slackUserId],
      })
    : await client.execute({
        sql: `SELECT slack_user_id, real_name, display_name, email, title, role, is_deleted, is_bot
                FROM slack_directory WHERE lower(email) = ?`,
        args: [email!],
      })
).rows;

if (found.length === 0) {
  console.error(`\n❌ Personne dans l’annuaire pour « ${slackUserId ?? email} ». Rien touché.`);
  console.error('   Synchroniser d’abord : `npm run directory:sync`.');
  process.exit(1);
}

// ⚠️ Une adresse peut désigner PLUSIEURS lignes (la colonne email n'est pas unique). On refuse
// plutôt que d'en choisir une : sur une colonne d'autorisation, « la première trouvée » est la
// forme la plus discrète du mauvais destinataire.
if (found.length > 1) {
  console.error(`\n❌ ${found.length} lignes portent cette adresse. Désigner par identifiant :`);
  for (const row of found) console.error(`     --slack-user-id ${String(row.slack_user_id)}`);
  process.exit(1);
}

const target = found[0]!;

if (target.is_bot) {
  console.error('\n❌ C’est un bot. La politique le REFUSE quel que soit son rôle.');
  process.exit(1);
}

if (target.is_deleted) {
  console.error('\n❌ Ce compte Slack est désactivé. La politique le REFUSE quel que soit son rôle.');
  process.exit(1);
}

console.log(`\nCible : ${nameOf(target)} <${String(target.email ?? '—')}>`);
console.log(`  identifiant  : ${String(target.slack_user_id)}`);
console.log(`  titre Slack  : ${String(target.title ?? '—')}   (déclaratif — ne décide rien)`);
console.log(`  rôle actuel  : ${String(target.role ?? '(null)')}`);
console.log(`  rôle demandé : ${requested}`);

// ─────────────────────────────────────────────────────────────────────────────
// LES HOMONYMES — le piège « ça marche pour mon compte de test »
// ─────────────────────────────────────────────────────────────────────────────
//
// Une même personne peut avoir DEUX comptes Slack (constaté en production : le General Manager
// en a un `@kissohq.com` et un `@trellix.io`). La frontière porte sur le COMPTE, pas sur
// l'humain : désigner l'un laisse l'autre en `readonly`. Sans cet avertissement, le symptôme
// serait « le bot m'obéit depuis un compte et pas depuis l'autre », et personne ne ferait le
// lien. C'est la forme exacte du défaut du 2026-08-19, où une feature marchait pour son testeur.
const homonymes = (
  await client.execute({
    sql: `SELECT slack_user_id, email, role FROM slack_directory
           WHERE is_bot = 0 AND is_deleted = 0
             AND slack_user_id <> ?
             AND lower(coalesce(real_name, display_name)) = ?`,
    args: [String(target.slack_user_id), nameOf(target).toLowerCase()],
  })
).rows;

if (homonymes.length > 0) {
  console.log(`\n  ⚠️ ${homonymes.length} autre(s) compte(s) au MÊME NOM :`);
  for (const row of homonymes) {
    console.log(
      `       ${String(row.slack_user_id)}  ${String(row.email ?? '—')}  rôle=${String(row.role)}`,
    );
  }
  console.log(
    '     La frontière porte sur le COMPTE, pas sur la personne. Depuis ces comptes-là,\n' +
      '     la même personne restera en lecture seule.',
  );
}

if (target.role === requested) {
  console.log('\n✓ Déjà à cette valeur. Rien à faire.\n');
  process.exit(0);
}

if (!apply) {
  console.log('\n(dry-run) Relancer avec `--apply` pour écrire.\n');
  process.exit(0);
}

const result = await client.execute({
  sql: 'UPDATE slack_directory SET role = ? WHERE slack_user_id = ?',
  args: [requested, String(target.slack_user_id)],
});

// On REND le compte plutôt que de supposer — voir plus haut.
const touched = Number(result.rowsAffected ?? 0);
if (touched !== 1) {
  console.error(`\n❌ ${touched} ligne(s) touchée(s), attendu 1. Vérifier la base.`);
  process.exit(1);
}

console.log(`\n✅ ${nameOf(target)} porte désormais le rôle « ${requested} ».`);

// ⚠️ RELECTURE APRÈS ÉCRITURE. Une ligne modifiée n'est pas une ligne dont la valeur est celle
// qu'on croit — et sur une colonne d'autorisation, la différence n'est pas académique.
const after = (
  await client.execute({
    sql: 'SELECT role FROM slack_directory WHERE slack_user_id = ?',
    args: [String(target.slack_user_id)],
  })
).rows[0];
console.log(`   Relu en base : role = ${String(after?.role ?? '(null)')}`);

console.log(
  '\n   Effet dans la minute (le garde re-vérifie toutes les 60 s tant qu’aucun manager n’est\n' +
    '   trouvé) — aucun redéploiement nécessaire. Vue complète : `npm run probe:authz`\n',
);
