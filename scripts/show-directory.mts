/**
 * Affiche ce que la base sait des PERSONNES et des CANAUX.
 *
 * ── Pourquoi ce script plutôt qu'une suppression ────────────────────────────
 * La demande était « voilà ce que je veux **retrouver** dans la base ». C'est une exigence
 * d'AFFICHAGE, et le panel a tranché : on ne détruit pas des lignes pour rendre une lecture
 * propre. Les 27 bots et les 8 comptes désactivés de `slack_directory` ont bel et bien un
 * compte Slack — ils ne relèvent donc pas du critère de suppression — et surtout `is_deleted`
 * est précisément le fait sur lequel la frontière d'autorisation refuse un ex-salarié. Les
 * effacer désarmerait ce refus.
 *
 * Ce qui a été réellement supprimé l'a été par `scripts/prune-employees-without-slack.mts` :
 * les fiches `employees` sans aucun compte Slack actif, en soft delete et avec une ligne
 * d'audit.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npx tsx --env-file=.env scripts/show-directory.mts
 *     npx tsx --env-file=.env scripts/show-directory.mts --all   # bots et comptes désactivés
 */
import { createClient } from '@libsql/client';

const showAll = process.argv.includes('--all');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant. Lancer avec --env-file=.env');
  process.exit(1);
}

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

/** Une valeur absente s'affiche `null`, littéralement — c'est ce qui a été demandé. */
const show = (value: unknown): string =>
  value === null || value === undefined || value === '' ? 'null' : String(value);

// ─────────────────────────────────────────────────────────────────────────────
// PERSONNES
// ─────────────────────────────────────────────────────────────────────────────

const filtre = showAll ? '' : 'WHERE is_deleted = 0';

const people = (
  await client.execute(
    `SELECT slack_user_id, first_name, last_name, real_name, email, title, is_bot, is_deleted,
            employee_id, dm_channel_id, synced_at
       FROM slack_directory ${filtre}
      ORDER BY is_bot, lower(coalesce(first_name, real_name))`,
  )
).rows;

console.log(`\n═══ PERSONNES ═══ (${people.length}${showAll ? '' : ' actives'})\n`);

for (const row of people) {
  // `is_bot` est affiché et non filtré : « Kaido » est un compte de BOT, sans email ni poste.
  // Le lister comme une personne sans le dire produirait deux réponses contradictoires à
  // « qui est-ce ? » selon la table qu'on interroge — et `resolveAccess` refuse `is_bot` en
  // toute première règle.
  let nature = '';
  if (row.is_bot) nature = ' [BOT]';
  else if (row.is_deleted) nature = ' [COMPTE DÉSACTIVÉ]';
  console.log(`  ${show(row.first_name)} ${show(row.last_name)}${nature}`);
  console.log(`    ID     : ${row.slack_user_id}`);
  console.log(`    email  : ${show(row.email)}`);
  console.log(`    poste  : ${show(row.title)}`);
  if (row.employee_id) console.log(`    employé: ${row.employee_id}`);
  console.log();
}

// ─────────────────────────────────────────────────────────────────────────────
// CANAUX
// ─────────────────────────────────────────────────────────────────────────────

try {
  const channels = (
    await client.execute(
      `SELECT channel_id, name, is_private, member_count_reported, synced_at
         FROM slack_channels WHERE is_member = 1 ORDER BY name`,
    )
  ).rows;

  console.log(`═══ CANAUX OÙ LE BOT EST INVITÉ ═══ (${channels.length})\n`);

  for (const channel of channels) {
    const members = (
      await client.execute({
        sql: `SELECT m.slack_user_id,
                     coalesce(d.first_name || ' ' || coalesce(d.last_name, ''), d.real_name, m.slack_user_id) AS label,
                     coalesce(d.is_bot, 0) AS is_bot
                FROM slack_channel_members m
                LEFT JOIN slack_directory d ON d.slack_user_id = m.slack_user_id
               WHERE m.channel_id = ?
               ORDER BY is_bot, label`,
        args: [channel.channel_id],
      })
    ).rows;

    console.log(`  #${channel.name}${channel.is_private ? ' (privé)' : ''}`);
    console.log(`    ID              : ${channel.channel_id}`);
    // Deux chiffres, et l'écart est une information. `member_count_reported` vient de
    // `conversations.list`, la liste de `conversations.members` : deux appels, deux instants.
    // Le compte qui fait foi est celui des lignes ; l'écart signale une synchronisation en
    // retard, gratuitement.
    console.log(`    membres (stockés): ${members.length}`);
    console.log(`    membres (Slack)  : ${show(channel.member_count_reported)}`);
    for (const member of members) {
      console.log(
        `      · ${member.label}${member.is_bot ? ' [bot]' : ''}  ${member.slack_user_id}`,
      );
    }
    const age = channel.synced_at
      ? `${Math.round((Date.now() - Number(channel.synced_at)) / 60000)} min`
      : '?';
    console.log(`    dernière synchro : il y a ${age}\n`);
  }
} catch (error) {
  // La table peut ne pas encore exister sur une base neuve : c'est un état, pas une panne.
  console.log('═══ CANAUX ═══\n');
  console.log(`  Indisponible : ${(error as Error).message}`);
  console.log('  → appliquer scripts/ddl-slack-channels.sql puis lancer la synchronisation.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYÉS — la table métier, distincte de l'annuaire
// ─────────────────────────────────────────────────────────────────────────────

const employees = (
  await client.execute(
    'SELECT id, first_name, last_name, email, department, position, deleted_at FROM employees ORDER BY created_at',
  )
).rows;

console.log('═══ EMPLOYÉS (table métier) ═══\n');
for (const row of employees) {
  const état = row.deleted_at ? `SUPPRIMÉ le ${row.deleted_at}` : 'actif';
  console.log(
    `  ${row.first_name} ${row.last_name} <${row.email}> — ${row.position} / ${row.department} — ${état}`,
  );
}
console.log(
  '\n  Rappel : `employees.position` est le poste CONTRACTUEL, `slack_directory.title` le poste\n' +
    '  DÉCLARÉ dans Slack. Deux faits, deux sources — aucun arbitrage automatique entre eux.\n',
);
