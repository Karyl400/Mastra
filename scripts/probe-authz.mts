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
 *     npx tsx --env-file=.env scripts/probe-authz.mts --all   # bots et comptes désactivés
 *
 * Il ne prend aucun paramètre de politique : depuis le 2026-08-20, la décision ne dépend
 * plus d'une variable d'environnement mais d'un fait en base — le rôle. Il n'y a donc rien à
 * simuler, seulement à constater. Pour changer le résultat : `npm run role:set`.
 */
import { createClient } from '@libsql/client';

import { makeDbExec } from './lib/resilient-db';

import {
  resolveAccess,
  type AccessSubject,
} from '../src/features/directory/domain/services/access-policy';
import { EmployeeRole } from '../src/shared/types';

const showAll = process.argv.includes('--all');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant. Lancer avec --env-file=.env');
  process.exit(1);
}

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║  AUTHZ_ENFORCE — ce qui se passerait, sur les données de cette base      ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝');
console.log(
  '\n`full` — l’accès aux données de TOUT LE MONDE — n’est accordé qu’au porteur du rôle\n' +
    '`manager`. Tous les autres gardent leur PROPRE dossier et rien de plus.\n',
);

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

const dbExec = makeDbExec(client);

const rows = (
  await dbExec(
    `SELECT slack_user_id, real_name, display_name, email, title, role, is_bot, is_restricted,
            is_ultra_restricted, is_deleted, employee_id
       FROM slack_directory
      ORDER BY is_bot, is_deleted, lower(coalesce(real_name, display_name, slack_user_id))`,
  )
).rows;

/** Les dossiers employé ENCORE actifs — un soft-delete n'est résolvable nulle part. */
const liveEmployeeIds = new Set(
  (await dbExec('SELECT id FROM employees WHERE deleted_at IS NULL')).rows.map((r) => String(r.id)),
);

interface Line {
  readonly subject: AccessSubject;
  readonly name: string;
  readonly title: string;
  readonly level: string;
  readonly reason: string;
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
    isManager: String(row.role ?? '') === EmployeeRole.Manager,
  };
  const decision = resolveAccess(subject);
  const employeeId = row.employee_id ? String(row.employee_id) : null;

  return {
    subject,
    name: String(row.real_name || row.display_name || row.slack_user_id),
    title: String(row.title ?? '—'),
    level: decision.level,
    reason: decision.reason,
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
  `${pad('PERSONNE', 22)}${pad('TITRE SLACK', 22)}${pad('NIVEAU', 10)}${pad('MOTIF', 18)}DOSSIER`,
);
console.log('─'.repeat(84));

for (const line of shown) {
  const MARKS: Record<string, string> = { full: '★', denied: '✗' };
  const mark = MARKS[line.level] ?? '·';
  console.log(
    `${mark} ${pad(line.name, 20)}${pad(line.title, 22)}${pad(line.level, 10)}${pad(line.reason, 18)}` +
      (line.linkedToLiveRecord ? 'lié' : 'aucun'),
  );
}

// ⚠️ Le TITRE est affiché à côté du NIVEAU pour rendre visible qu'ils sont SANS RAPPORT — c'est
// la confusion que ce produit doit rendre impossible. Relevé en production : « Product Manager »
// sur quelqu'un qui n'est pas le manager, « Software Engineer » sur l'administratrice de
// l'onboarding. Un titre est déclaratif ; un rôle est un droit.

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
    '\n⛔ PERSONNE ne garderait `full`. `SlackAccessGuard` REFUSE alors d’appliquer et reste\n' +
      '   en observation : poser AUTHZ_ENFORCE=true ne changerait rien, et c’est délibéré —\n' +
      '   appliquer rétrograderait l’organisation entière sur une désignation oubliée.\n' +
      '   Désigner quelqu’un : `npm run role:set -- --email <adresse> --apply`',
  );
}

if (linkedButDowngraded.length > 0) {
  console.log(
    '\n   Ces personnes ont un dossier employé actif sans porter le rôle. Elles gardent leur\n' +
      '   propre dossier et le droit d’agir dessus ; ce qu’elles n’ont pas, c’est celui des\n' +
      '   autres. C’est le comportement VOULU, pas un avertissement.',
  );
  for (const l of linkedButDowngraded) {
    console.log(`      • ${l.name} — motif : ${l.reason}`);
  }
}

const withoutRecord = downgraded.filter((l) => !l.linkedToLiveRecord);
if (withoutRecord.length > 0) {
  console.log(
    `\n   ${withoutRecord.length} personne(s) sans dossier employé. Elles ne perdent RIEN de ce\n` +
      '   qu’elles ont : `readonly` ferme l’accès aux dossiers des AUTRES, et elles n’en ont\n' +
      '   pas à elles. Le geste qui leur manque n’est pas une promotion, c’est un dossier —\n' +
      '   `npm run profile:invite`, ou le formulaire demandé en DM.',
  );
}

console.log('\n─── RAPPEL ────────────────────────────────────────────────────────────────');
console.log(
  '  `readonly` est le cas NOMINAL depuis le 2026-08-20, et il ne coupe personne de\n' +
    '  soi-même : `canReadPersonRecord` ET `canPerformSideEffects` comparent sur\n' +
    '  `employees.id` AVANT de regarder le niveau — chacun lit son dossier et agit dessus.\n' +
    '  Ce que `readonly` ferme, c’est l’accès aux dossiers des AUTRES.',
);
console.log(
  '  Ce script n’écrit rien et n’active rien. Poser la variable reste un geste humain.\n',
);
