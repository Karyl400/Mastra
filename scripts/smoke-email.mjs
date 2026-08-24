#!/usr/bin/env node
/**
 * Smoke test Email SMTP — Marcel
 *
 * Usage:
 *   node --env-file=.env scripts/smoke-email.mjs
 *   node --env-file=.env scripts/smoke-email.mjs --to=quelquun@example.com
 *   node --env-file=.env scripts/smoke-email.mjs --to=… --dry   (aucun envoi)
 *
 * Étapes : lecture de la config → transporter.verify() (connexion + auth, sans
 * envoi) → UN SEUL email réel au destinataire. Jamais de boucle, jamais d'envoi
 * en masse : une exécution = au plus un message.
 *
 * Pourquoi ce script : l'échec d'envoi est SILENCIEUX dans le workflow
 * (`sendWelcomeEmail` pose `emailSent: false` mais renvoie `status: 'success'`).
 * Ici au contraire chaque étape est explicite et le code de sortie est fiable.
 */

import nodemailer from 'nodemailer';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const DEFAULT_TO = 'karylsoumaila1@gmail.com';
const to = typeof args.to === 'string' ? args.to : DEFAULT_TO;
const dryRun = args.dry === true;

const results = [];

function ok(label, detail = '') {
  results.push({ ok: true, label, detail });
  console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, err) {
  const detail = err instanceof Error ? err.message : String(err);
  results.push({ ok: false, label, detail });
  console.error(`❌ ${label} — ${detail}`);
}

async function step(label, fn) {
  try {
    const detail = await fn();
    ok(label, detail ?? '');
    return true;
  } catch (err) {
    fail(label, err);
    return false;
  }
}

/** Ne jamais afficher un secret : uniquement sa présence et sa longueur. */
function maskSecret(value) {
  if (!value) return 'absent';
  return `présent (${value.length} caractères)`;
}

/**
 * Traduit les erreurs SMTP les plus coûteuses en temps de debug.
 * Le 534 Gmail est le grand classique : le mot de passe n'est pas « faux »,
 * il est du mauvais type.
 */
function explain(err) {
  const code = err?.responseCode;
  const msg = err?.message ?? '';

  if (code === 534 || /application-specific password/i.test(msg)) {
    return [
      'Gmail refuse le mot de passe habituel du compte pour SMTP (534-5.7.9).',
      "Il faut un MOT DE PASSE D'APPLICATION de 16 caractères :",
      '  Compte Google → Sécurité → Validation en deux étapes (à activer d’abord)',
      '                → Mots de passe des applications → Générer',
      'Colle-le dans SMTP_PASS (les espaces sont tolérés par Google, mais autant les retirer).',
    ].join('\n   ');
  }

  if (code === 535 || /username and password not accepted/i.test(msg)) {
    return [
      'Identifiants refusés (535). Vérifie que SMTP_USER est bien l’adresse Gmail complète',
      "et que le mot de passe d'application n'a pas été révoqué.",
    ].join('\n   ');
  }

  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(err?.code ?? '')) {
    return [
      `Connexion impossible à ${process.env.SMTP_HOST}:${process.env.SMTP_PORT ?? 587} (${err.code}).`,
      'Port 587 = STARTTLS, port 465 = TLS implicite. Un pare-feu peut bloquer le 587 sortant.',
    ].join('\n   ');
  }

  if (code === 550 || code === 553) {
    return `Expéditeur ou destinataire refusé (${code}). NOTIFICATION_FROM doit correspondre au compte SMTP_USER.`;
  }

  return null;
}

/**
 * ⚠️ RECOPIE ASSUMÉE, ET SURVEILLÉE. Ce script est du `.mjs` lancé par `node` nu :
 * il ne peut pas importer `ASSISTANT_NAME` depuis `src/shared/assistant-identity.ts`,
 * qui est du TypeScript. Le nom est donc écrit une seconde fois — et
 * `tests/unit/notification/email-sender-identity.test.ts` vérifie que les deux
 * disent la même chose. Sans ce contrôle, un renommage de l'assistant laisserait
 * le smoke test envoyer un VRAI email signé d'un nom que la production n'emploie plus,
 * et le seul instrument de vérification de la chaîne SMTP mentirait sur ce qu'elle produit.
 */
const SENDER_NAME = 'Marcel';

console.log('\n📧 Smoke test Email SMTP — Marcel\n');

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT ?? 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.NOTIFICATION_FROM || user;

console.log('Configuration lue depuis l’environnement :');
console.log(`   SMTP_HOST          = ${host ?? '(absent)'}`);
console.log(`   SMTP_PORT          = ${port} (${port === 465 ? 'TLS implicite' : 'STARTTLS'})`);
console.log(`   SMTP_USER          = ${user ?? '(absent)'}`);
console.log(`   SMTP_PASS          = ${maskSecret(pass)}`);
console.log(`   NOTIFICATION_FROM  = ${from ?? '(absent)'}`);
console.log(`   Destinataire       = ${to}${dryRun ? '  [DRY RUN — aucun envoi]' : ''}\n`);

const missing = [
  ['SMTP_HOST', host],
  ['SMTP_USER', user],
  ['SMTP_PASS', pass],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`❌ Variables manquantes : ${missing.join(', ')}`);
  console.error('   Lance le script avec --env-file=.env, ou complète le .env.\n');
  process.exit(1);
}

if (pass.replace(/\s/g, '').length !== 16 && /gmail\.com$/i.test(host)) {
  console.warn(
    "⚠️  SMTP_PASS ne fait pas 16 caractères : un mot de passe d'application Google en fait 16.\n" +
      '   Si le verify échoue en 534, c’est probablement la cause.\n',
  );
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 15_000,
});

const verified = await step('transporter.verify() (connexion + authentification)', async () => {
  try {
    await transporter.verify();
    return `${host}:${port} joignable, identifiants acceptés`;
  } catch (err) {
    const hint = explain(err);
    if (hint) console.error(`   ↳ ${hint}`);
    throw err;
  }
});

if (!verified) {
  console.log('\n────────────────────────────────────');
  console.log('Aucun email envoyé : l’authentification a échoué.\n');
  transporter.close();
  process.exit(1);
}

if (dryRun) {
  console.log('\nℹ️  --dry : envoi ignoré, la connexion est validée.');
} else {
  // UN SEUL envoi, volontairement hors de toute boucle.
  await step(`sendMail (1 message → ${to})`, async () => {
    try {
      const info = await transporter.sendMail({
        from: `"${SENDER_NAME}" <${from}>`,
        to,
        subject: `${SENDER_NAME} — test SMTP`,
        html:
          '<p>Bonjour,</p>' +
          `<p>Ce message confirme que les emails signés ${SENDER_NAME} ` +
          'partent bien via SMTP.</p>' +
          `<p style="color:#666;font-size:12px">Émis par <code>scripts/smoke-email.mjs</code> le ${new Date().toISOString()}.</p>`,
        text:
          `Bonjour,\n\nCe message confirme que les emails signés ${SENDER_NAME} ` +
          `partent bien via SMTP.\n\nÉmis par scripts/smoke-email.mjs le ${new Date().toISOString()}.\n`,
      });

      const accepted = (info.accepted ?? []).join(', ') || '(aucun)';
      const rejected = (info.rejected ?? []).join(', ');
      if (rejected) console.warn(`   ⚠️  Rejetés par le serveur : ${rejected}`);
      return `messageId=${info.messageId} accepté=${accepted} réponse="${info.response ?? ''}"`;
    } catch (err) {
      const hint = explain(err);
      if (hint) console.error(`   ↳ ${hint}`);
      throw err;
    }
  });
}

transporter.close();

const failed = results.filter((r) => !r.ok);
console.log('\n────────────────────────────────────');
console.log(`Résultat: ${results.length - failed.length}/${results.length} OK`);

if (failed.length) {
  console.log('\nÉchecs :');
  for (const f of failed) console.log(`  • ${f.label}: ${f.detail}`);
  process.exit(1);
}

console.log(`\n✅ SMTP opérationnel — vérifie la boîte de réception de ${to}.`);
console.log('   (Pense à regarder le dossier spam au premier envoi.)\n');
