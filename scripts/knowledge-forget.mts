/**
 * EFFACER LA BASE DE CONNAISSANCE D'UNE PERSONNE — le geste que l'escalade n'avait pas.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce script existe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `ERASURE_SCOPE_NOTICE` nomme honnêtement ce que le court-circuit conversationnel ne couvre
 * pas, et renvoie vers le General Manager. L'audit du 2026-08-21 a constaté que **ce renvoi
 * pointait vers un geste sans implémentation** : `forget` était écrite dans les deux ports,
 * implémentée quatre fois, et appelée nulle part. Le General Manager aurait dû écrire du SQL à
 * la main sur la Turso de production.
 *
 * Depuis le 2026-08-21, le court-circuit efface l'archive du DM où il est prononcé. Ce script
 * couvre l'autre moitié — **la demande RGPD complète**, tous canaux confondus — parce qu'une
 * portée aussi large ne doit jamais être déclenchée par une phrase en passant.
 *
 * ⚠️ **IL SUPPRIME RÉELLEMENT, ET C'EST IRRÉVERSIBLE.** Dry-run par défaut, comme `role:set`,
 * `directory:sync` et `profile:invite`. Sauvegarder avant, comme pour `probe-erasure`.
 *
 * ⚠️ **LES DEUX TABLES PARTENT ENSEMBLE.** `knowledge_facts` est DÉRIVÉE de `channel_messages` :
 * n'effacer que l'une laisserait un résumé sans sa source, que `searchKnowledge` continuerait de
 * rendre — la trace disparaît, l'affirmation reste. Les faits partent en premier : l'état
 * intermédiaire acceptable est « des messages sans faits », rejouable par distillation.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npm run knowledge:forget                                  # inventaire
 *     npm run knowledge:forget -- --user U0KARYL                # ce qui serait effacé
 *     npm run knowledge:forget -- --user U0KARYL --apply        # effacement réel
 *     npm run knowledge:forget -- --user U0KARYL --channel D0X --apply   # un seul canal
 */
import { createClient } from '@libsql/client';

const args = process.argv.slice(2);
const at = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const apply = args.includes('--apply');
const user = at('--user')?.trim();
const channel = at('--channel')?.trim();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant. Lancer avec --env-file=.env');
  process.exit(1);
}

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

async function inventory(): Promise<void> {
  const rows = (
    await client.execute(
      `SELECT m.slack_user_id AS uid,
              coalesce(d.real_name, d.display_name, m.slack_user_id) AS nom,
              count(*) AS messages,
              count(DISTINCT m.channel_id) AS canaux,
              min(m.posted_at) AS plus_ancien
         FROM channel_messages m
         LEFT JOIN slack_directory d ON d.slack_user_id = m.slack_user_id
        GROUP BY m.slack_user_id
        ORDER BY messages DESC`,
    )
  ).rows;

  if (rows.length === 0) {
    console.log('\nL’archive est vide — aucun message n’a encore été ingéré.');
    console.log('⚠️  Si c’est inattendu : `message.channels` / `message.groups` sont-ils');
    console.log('    abonnés dans la console Slack ? Sans eux, rien n’arrive jamais.\n');
    return;
  }

  console.log(`\n${rows.length} personne(s) présente(s) dans l’archive :\n`);
  for (const row of rows) {
    const age = row.plus_ancien
      ? new Date(Number(row.plus_ancien)).toISOString().slice(0, 10)
      : '—';
    console.log(
      `  ${String(row.nom)}`.padEnd(28) +
        `${String(row.uid)}`.padEnd(14) +
        `${String(row.messages)} messages`.padEnd(16) +
        `${String(row.canaux)} canaux`.padEnd(12) +
        `depuis ${age}`,
    );
  }
  console.log('');
}

async function main(): Promise<void> {
  await inventory();

  if (!user) {
    console.log('Rien à faire : préciser `--user <U…>` pour cibler quelqu’un.\n');
    return;
  }

  const scope = channel ? { channel } : null;
  const where = channel ? 'slack_user_id = ? AND channel_id = ?' : 'slack_user_id = ?';
  const params = channel ? [user, channel] : [user];

  const messages = Number(
    (
      await client.execute({
        sql: `SELECT count(*) AS n FROM channel_messages WHERE ${where}`,
        args: params,
      })
    ).rows[0]?.n ?? 0,
  );
  const facts = Number(
    (
      await client.execute({
        sql: `SELECT count(*) AS n FROM knowledge_facts WHERE ${where}`,
        args: params,
      })
    ).rows[0]?.n ?? 0,
  );

  const portee = scope ? `dans le canal ${channel}` : 'DANS TOUS LES CANAUX';
  console.log(`Cible : ${user} ${portee}`);
  console.log(`  ${messages} message(s) archivé(s)`);
  console.log(`  ${facts} fait(s) distillé(s)\n`);

  if (messages === 0 && facts === 0) {
    console.log('Rien à effacer.\n');
    return;
  }

  if (!apply) {
    console.log('DRY-RUN — rien n’a été supprimé. Ajouter `--apply` pour exécuter.');
    console.log('⚠️  L’opération est IRRÉVERSIBLE. Sauvegarder d’abord.\n');
    return;
  }

  // ⚠️ Les FAITS d'abord — voir l'en-tête. L'ordre inverse laisserait des résumés orphelins.
  const removedFacts = (
    await client.execute({ sql: `DELETE FROM knowledge_facts WHERE ${where}`, args: params })
  ).rowsAffected;
  const removedMessages = (
    await client.execute({ sql: `DELETE FROM channel_messages WHERE ${where}`, args: params })
  ).rowsAffected;

  console.log(`Effacé : ${removedMessages} message(s), ${removedFacts} fait(s).`);

  // RELIRE APRÈS ÉCRITURE — même discipline que `role:set`. Un `rowsAffected` est une
  // affirmation du client ; un SELECT est une observation.
  const reste = Number(
    (
      await client.execute({
        sql: `SELECT count(*) AS n FROM channel_messages WHERE ${where}`,
        args: params,
      })
    ).rows[0]?.n ?? 0,
  );
  console.log(reste === 0 ? 'Vérifié : il ne reste rien.\n' : `⚠️  Il reste ${reste} ligne(s).\n`);
}

main()
  .catch((error) => {
    console.error('Échec :', error);
    process.exit(1);
  })
  .finally(() => client.close());
