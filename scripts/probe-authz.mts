/**
 * QUI PERDRAIT QUOI si l'on posait `AUTHZ_ENFORCE=true` — sur les données RÉELLES.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ce script existe
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `access-guard.ts` prescrit la bonne méthode : « journaliser ce qui SERAIT refusé, sans rien
 * refuser, lire les logs, puis activer ». Elle a un angle mort — le mode observation ne
 * journalise QUE les gens qui écrivent au bot. Une personne qui ne lui a jamais parlé n'apparaît
 * dans aucun log, et c'est pourtant elle qu'on cassera le jour de l'activation. Sur un workspace
 * de six personnes réelles dont le bot voit deux ou trois par semaine, « lire les logs » ne peut
 * structurellement pas rendre la réponse complète.
 *
 * Ce script la rend : il évalue TOUT l'annuaire, d'un coup, avant de toucher à quoi que ce soit.
 *
 * ⚠️ Il IMPORTE `resolveAccess`, il ne le réimplémente pas. Une seconde copie de la règle
 * d'autorisation dirait, un jour, autre chose que la première — et ce serait précisément le
 * jour où quelqu'un s'en sert pour décider d'activer. C'est la même exigence que pour
 * `agentToolBoundary`, dérivé de `Object.keys(tools)` plutôt que rédigé.
 *
 * ── LECTURE SEULE ───────────────────────────────────────────────────────────
 * Aucune écriture, aucun email, aucun message Slack. Un `SELECT`, et c'est tout.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npx tsx --env-file=.env scripts/probe-authz.mts
 *     npx tsx --env-file=.env scripts/probe-authz.mts --domains=kissohq.com
 *     npx tsx --env-file=.env scripts/probe-authz.mts --domains=kissohq.com,exemple.fr --all
 *
 * Sans `--domains`, il lit `SLACK_ORG_EMAIL_DOMAINS` — donc il mesure ce qui se passerait
 * avec la configuration ACTUELLE, qui est la première question à se poser.
 */
import { createClient } from '@libsql/client';

import {
  readOrgEmailDomains,
  resolveAccess,
  type AccessSubject,
} from '../src/features/directory/domain/services/access-policy';

const showAll = process.argv.includes('--all');
const domainsArg = process.argv.find((a) => a.startsWith('--domains='))?.slice('--domains='.length);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant. Lancer avec --env-file=.env');
  process.exit(1);
}

const orgEmailDomains = readOrgEmailDomains(domainsArg ?? process.env.SLACK_ORG_EMAIL_DOMAINS);
const policy = { orgEmailDomains };

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║  AUTHZ_ENFORCE — ce qui se passerait, sur les données de cette base      ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝');
console.log(
  `\nDomaines de l'organisation : ${orgEmailDomains.length > 0 ? orgEmailDomains.join(', ') : '(AUCUN)'}` +
    `${domainsArg ? '   [passés en argument]' : '   [lus dans SLACK_ORG_EMAIL_DOMAINS]'}`,
);

if (orgEmailDomains.length === 0) {
  console.log(
    '\n⚠️  Aucun domaine déclaré. `canEnforce()` REFUSE alors d’appliquer et reste en\n' +
      '    observation — poser AUTHZ_ENFORCE=true ne changerait donc rien du tout. Le\n' +
      '    tableau ci-dessous montre néanmoins la décision que la politique CALCULE.',
  );
}

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

const rows = (
  await client.execute(
    `SELECT slack_user_id, real_name, display_name, email, is_bot, is_restricted,
            is_ultra_restricted, is_deleted, employee_id
       FROM slack_directory
      ORDER BY is_bot, is_deleted, lower(coalesce(real_name, display_name, slack_user_id))`,
  )
).rows;

/** Les employés ENCORE actifs : un dossier soft-deleted n'est plus résolvable nulle part. */
const liveEmployeeIds = new Set(
  (await client.execute('SELECT id FROM employees WHERE deleted_at IS NULL')).rows.map((r) =>
    String(r.id),
  ),
);

interface Line {
  readonly subject: AccessSubject;
  readonly name: string;
  readonly level: string;
  readonly reason: string;
  readonly linked: boolean;
  readonly linkedToLiveRecord: boolean;
}

const lines: Line[] = rows.map((row) => {
  const subject: AccessSubject = {
    slackUserId: String(row.slack_user_id),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    isBot: Boolean(row.is_bot),
    isRestricted: Boolean(row.is_restricted),
    isUltraRestricted: Boolean(row.is_ultra_restricted),
    isDeleted: Boolean(row.is_deleted),
  };
  const decision = resolveAccess(subject, policy);
  const employeeId = row.employee_id ? String(row.employee_id) : null;

  return {
    subject,
    name: String(row.real_name || row.display_name || row.slack_user_id),
    level: decision.level,
    reason: decision.reason,
    linked: employeeId !== null,
    linkedToLiveRecord: employeeId !== null && liveEmployeeIds.has(employeeId),
  };
});

/** Les bots et les comptes désactivés ne parlent jamais au bot : ils ne sont pas la question. */
const humans = lines.filter((l) => !l.subject.isBot && !l.subject.isDeleted);
const shown = showAll ? lines : humans;

console.log(
  `\n${rows.length} lignes d’annuaire — ${humans.length} personnes vivantes non-bot` +
    `${showAll ? '' : ' (--all pour tout voir)'}\n`,
);

const pad = (value: string, width: number) =>
  value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);

console.log(
  `${pad('PERSONNE', 24)}${pad('DOMAINE', 18)}${pad('NIVEAU', 10)}${pad('MOTIF', 22)}DOSSIER`,
);
console.log('─'.repeat(88));

for (const line of shown) {
  const email = line.subject.email ?? '';
  const domain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '(pas d’email)';
  const dossier = line.linkedToLiveRecord
    ? 'lié'
    : line.linked
      ? 'lié à un dossier supprimé'
      : 'aucun';
  const mark = line.level === 'full' ? ' ' : line.level === 'denied' ? '✗' : '·';
  console.log(
    `${mark} ${pad(line.name, 22)}${pad(domain, 18)}${pad(line.level, 10)}${pad(line.reason, 22)}${dossier}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CE QUI DÉCIDE — les trois questions qu'on se pose avant de poser la variable
// ─────────────────────────────────────────────────────────────────────────────
const full = humans.filter((l) => l.level === 'full');
const downgraded = humans.filter((l) => l.level === 'readonly');
const linkedButDowngraded = downgraded.filter((l) => l.linkedToLiveRecord);

console.log('\n─── VERDICT ───────────────────────────────────────────────────────────────');
console.log(`  garderaient tous leurs outils (full) : ${full.length} / ${humans.length}`);
console.log(`  rétrogradés en lecture seule          : ${downgraded.length} / ${humans.length}`);

if (full.length === 0) {
  console.log(
    '\n⛔ PERSONNE ne garderait `full`. Activer en l’état rétrograderait l’organisation\n' +
      '   entière — exactement la panne que `canEnforce()` refuse déjà d’exécuter quand\n' +
      '   AUCUN domaine n’est déclaré, mais qu’un domaine ERRONÉ produirait tout aussi bien.',
  );
}

if (linkedButDowngraded.length > 0) {
  console.log(
    '\n⚠️  Ces personnes ONT un dossier employé actif et seraient pourtant rétrogradées.\n' +
      '   C’est le cas qui coûte le plus cher : quelqu’un que le produit connaît, et qui\n' +
      '   perdrait le droit d’agir.',
  );
  for (const l of linkedButDowngraded) {
    console.log(`      • ${l.name} — motif : ${l.reason}`);
  }
}

const foreign = downgraded.filter((l) => l.reason === 'foreign_domain');
if (foreign.length > 0) {
  const domains = [
    ...new Set(
      foreign.map((l) => {
        const e = l.subject.email ?? '';
        return e.slice(e.lastIndexOf('@') + 1);
      }),
    ),
  ];
  console.log(
    `\n   Domaines qui feraient rétrograder : ${domains.join(', ')}.\n` +
      '   Deux façons de traiter chacun, et elles ne se valent pas :\n' +
      '     1. corriger la DONNÉE — l’adresse du profil Slack pointe vers le domaine de\n' +
      '        l’organisation. Rien à configurer, rien à maintenir, et la règle reste\n' +
      '        dérivée d’un fait que Slack tient lui-même à jour ;\n' +
      '     2. ajouter le domaine à SLACK_ORG_EMAIL_DOMAINS — ce qui accorde `full` à\n' +
      '        TOUTE personne portant ce domaine, aujourd’hui et demain. Sur un domaine\n' +
      '        public (gmail.com, outlook.com), cela revient à n’avoir plus de frontière.',
  );
}

const noEmail = downgraded.filter((l) => l.reason === 'no_email');
if (noEmail.length > 0) {
  console.log(
    `\n   ${noEmail.length} personne(s) sans email exploitable dans l’annuaire. Vérifier que\n` +
      '   le scope `users:read.email` est toujours accordé, puis relancer\n' +
      '   `npx tsx --env-file=.env scripts/sync-slack-directory.mts` avant de conclure.',
  );
}

console.log('\n─── RAPPEL ────────────────────────────────────────────────────────────────');
console.log(
  '  `readonly` ne coupe personne du produit : la personne est servie par un agent sans\n' +
    '  outil à effet de bord, et elle garde SON PROPRE dossier (`canReadPersonRecord`\n' +
    '  compare sur `employees.id` AVANT de regarder le niveau) — à condition que sa ligne\n' +
    '  d’annuaire soit LIÉE. Une ligne non liée n’a pas de dossier à lire, donc rien à perdre.',
);
console.log('  Ce script n’écrit rien et n’active rien. Poser la variable reste un geste humain.\n');
