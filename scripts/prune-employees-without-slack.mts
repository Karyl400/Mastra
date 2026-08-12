/**
 * Retire de `employees` les personnes qui n'ont AUCUN compte Slack actif.
 *
 * ── Ce que « retirer » veut dire ici ────────────────────────────────────────
 * **Un soft delete, pas un DELETE.** Trois raisons, dans cet ordre d'importance :
 *
 *  1. `PRAGMA foreign_keys = 1` est ACTIF sur la Turso de production (vérifié le 2026-08-12).
 *     Awa TRAORE porte 5 lignes dans `tasks` et 1 dans `onboarding_progress` : un DELETE
 *     physique échoue, ou — si la contrainte venait à être désactivée — laisse des orphelins
 *     qui ne se remarqueront qu'au prochain rapport faux.
 *  2. La question « qui avons-nous intégré, et avec quel résultat ? » deviendrait définitivement
 *     sans réponse. Dans un système RH, la conservation est une obligation avant d'être un
 *     confort.
 *  3. Le soft delete a été livré la veille précisément pour ça, avec des tests qui verrouillent
 *     que la donnée SURVIT. Le contredire le lendemain sur un critère plus fragile que celui
 *     qu'il protège annulerait l'acquis en vingt-quatre heures.
 *
 * L'effet OBSERVABLE est celui d'une suppression : `findById`, `findByEmail` et `findAll`
 * filtrent `deleted_at`, donc la personne disparaît de toutes les lectures, de tous les tools
 * et de tous les agents. Ce qui reste est la ligne, et elle ne se lit plus que par SQL direct.
 *
 * ── ⚠️ Le critère est FRAGILE, et il faut le savoir ─────────────────────────
 * Le rapprochement se fait sur l'EMAIL, seul pont existant entre `employees` et
 * `slack_directory`. Or `slack_directory.email` est NULLABLE (les bots n'en ont pas, et le
 * champ dépend du scope `users:read.email`) et il est ÉDITÉ PAR SON PORTEUR dans son profil
 * Slack. Autrement dit : quelqu'un qui change son adresse dans Slack se rend invisible à ce
 * script, et se retrouve « sans compte Slack » au run suivant.
 *
 * C'est pourquoi le script est en DRY-RUN par défaut, exige `--apply`, et affiche nommément
 * chaque personne qu'il s'apprête à retirer. Ne jamais le mettre dans un cron.
 *
 * ── Ce qu'il ne fait PAS ────────────────────────────────────────────────────
 * Il ne touche ni aux bots ni aux comptes désactivés de `slack_directory` : ceux-là ONT un
 * compte Slack, ils ne relèvent donc pas du critère. Et `is_deleted` est justement le fait sur
 * lequel la frontière d'autorisation refuse un ex-salarié — les effacer désarmerait ce refus.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npx tsx --env-file=.env scripts/prune-employees-without-slack.mts            # dry-run
 *     npx tsx --env-file=.env scripts/prune-employees-without-slack.mts --apply
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { DrizzleEmployeeRepository } from '../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { writeAuditLog } from '../src/infrastructure/audit/audit-log';
import * as schema from '../src/infrastructure/database/schema';

const apply = process.argv.includes('--apply');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant. Lancer avec --env-file=.env');
  process.exit(1);
}

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
const db = drizzle(client, { schema });
const repo = new DrizzleEmployeeRepository(() => db as never);

console.log(apply ? '── MODE APPLY — écritures réelles ──\n' : '── DRY-RUN — aucune écriture ──\n');

/**
 * Adresses des comptes Slack ACTIFS. Les comptes désactivés sont volontairement exclus : un
 * ex-salarié n'a plus de compte utilisable, et le garder rattaché ferait échapper au critère
 * exactement les fiches qu'on cherche à retirer.
 */
const slackEmails = new Set(
  (
    await client.execute(
      "SELECT lower(trim(email)) AS email FROM slack_directory WHERE email IS NOT NULL AND email <> '' AND is_deleted = 0 AND is_bot = 0",
    )
  ).rows.map((row) => String(row.email)),
);

console.log(`Comptes Slack actifs porteurs d'une adresse : ${slackEmails.size}`);

const employees = (
  await client.execute(
    'SELECT id, first_name, last_name, email FROM employees WHERE deleted_at IS NULL ORDER BY created_at',
  )
).rows;

console.log(`Employés actifs en base : ${employees.length}\n`);

const orphans = employees.filter((row) => !slackEmails.has(String(row.email).toLowerCase().trim()));

if (orphans.length === 0) {
  console.log('Aucun employé sans compte Slack. Rien à faire.');
  process.exit(0);
}

console.log(`À RETIRER — ${orphans.length} fiche(s) sans compte Slack actif :`);
for (const row of orphans) {
  // Les dépendances sont affichées AVANT l'action : c'est ce qui rend la décision informée
  // plutôt que consentie. Elles ne bloquent pas — le soft delete les préserve toutes.
  const tasks = (
    await client.execute({
      sql: 'SELECT COUNT(*) AS n FROM tasks WHERE employee_id = ?',
      args: [row.id],
    })
  ).rows[0].n;
  const progress = (
    await client.execute({
      sql: 'SELECT COUNT(*) AS n FROM onboarding_progress WHERE employee_id = ?',
      args: [row.id],
    })
  ).rows[0].n;

  console.log(
    `  ${row.first_name} ${row.last_name} <${row.email}>\n` +
      `    id=${row.id}  tâches=${tasks}  suivi d'onboarding=${progress}`,
  );
}

if (!apply) {
  console.log('\nRien n’a été écrit. Relancer avec --apply pour appliquer.');
  process.exit(0);
}

console.log();
for (const row of orphans) {
  // On passe par le REPOSITORY et non par un `UPDATE` à la main : c'est lui qui porte
  // l'idempotence (`WHERE deleted_at IS NULL`, donc la date d'origine ne bouge jamais).
  await repo.delete(String(row.id));

  // Et on journalise. Un DELETE passé à la main en SQL sur la Turso contournerait
  // intégralement `audit_logs`, qui vient d'être branché — la première opération de données
  // significative après ce câblage serait alors la seule à n'y pas figurer.
  await writeAuditLog(
    {
      action: 'EMPLOYEE_SOFT_DELETED',
      actorId: 'script:prune-employees-without-slack',
      actorType: 'system',
      resourceType: 'Employee',
      resourceId: String(row.id),
      details: { reason: 'no_active_slack_account', email: row.email },
    },
    () => db as never,
  );

  console.log(`  retiré : ${row.first_name} ${row.last_name} (${row.id})`);
}

const restants = (
  await client.execute('SELECT COUNT(*) AS n FROM employees WHERE deleted_at IS NULL')
).rows[0].n;
console.log(`\nEmployés actifs restants : ${restants}`);
