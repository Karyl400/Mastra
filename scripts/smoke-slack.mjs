#!/usr/bin/env node
/**
 * Smoke test Slack — workspace Kisso Ind
 *
 * Usage:
 *   node --env-file=.env scripts/smoke-slack.mjs
 *   node --env-file=.env scripts/smoke-slack.mjs --email=toi@kisso.com
 *   node --env-file=.env scripts/smoke-slack.mjs --email=toi@kisso.com --channel=C0123 --invite
 *
 * Sans --invite : lecture seule (auth, channels, members, lookup email).
 */

import { WebClient } from '@slack/web-api';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('❌ SLACK_BOT_TOKEN manquant (.env)');
  process.exit(1);
}

const client = new WebClient(token);
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

console.log('\n🔍 Smoke test Slack — Kisso Ind\n');

await step('auth.test (bot connecté au workspace)', async () => {
  const res = await client.auth.test();
  return `team=${res.team} user=${res.user} teamId=${res.team_id}`;
});

await step('conversations.list (channels visibles)', async () => {
  const res = await client.conversations.list({
    types: 'public_channel,private_channel',
    limit: 200,
    exclude_archived: true,
  });
  const channels = res.channels ?? [];
  const preview = channels
    .slice(0, 8)
    .map((c) => `#${c.name} (${c.id}${c.is_private ? ', private' : ''})`)
    .join(', ');
  console.log('   Channels (échantillon):');
  for (const c of channels.slice(0, 20)) {
    console.log(
      `   - ${c.is_private ? '🔒' : '#'} ${c.name.padEnd(28)} ${c.id}  members=${c.num_members ?? '?'}`,
    );
  }
  if (channels.length > 20) {
    console.log(`   … +${channels.length - 20} autres`);
  }
  return `${channels.length} channels — ${preview}`;
});

await step('users.list (membres workspace)', async () => {
  const res = await client.users.list({ limit: 200 });
  const members = (res.members ?? []).filter((m) => !m.deleted && !m.is_bot);
  return `${members.length} humains (bots exclus)`;
});

if (typeof args.email === 'string') {
  await step(`users.lookupByEmail (${args.email})`, async () => {
    const res = await client.users.lookupByEmail({ email: args.email });
    const u = res.user;
    if (!u) throw new Error('user vide');
    return `id=${u.id} name=${u.name} real=${u.real_name}`;
  });
} else {
  console.log('ℹ️  Passe --email=toi@domaine.com pour tester findUserByEmail');
}

if (args.invite === true) {
  if (typeof args.email !== 'string' || typeof args.channel !== 'string') {
    fail('invite', '--invite requiert --email=… et --channel=C…');
  } else {
    await step(`conversations.invite (${args.email} → ${args.channel})`, async () => {
      const lookup = await client.users.lookupByEmail({ email: args.email });
      const userId = lookup.user?.id;
      if (!userId) throw new Error('utilisateur introuvable');
      try {
        await client.conversations.invite({ channel: args.channel, users: userId });
        return `invité ${userId} dans ${args.channel}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already_in_channel')) {
          return `déjà membre (${userId}) — OK`;
        }
        throw err;
      }
    });
  }
} else {
  console.log('ℹ️  Ajoute --invite --channel=C… --email=… pour tester l’invitation (écriture)');
}

if (typeof args.channel === 'string' && args.invite !== true) {
  await step(`conversations.members (${args.channel})`, async () => {
    const res = await client.conversations.members({ channel: args.channel, limit: 200 });
    return `${(res.members ?? []).length} membres`;
  });
}

const failed = results.filter((r) => !r.ok);
console.log('\n────────────────────────────────────');
console.log(`Résultat: ${results.length - failed.length}/${results.length} OK`);
if (failed.length) {
  console.log('\nÉchecs → scopes / membership bot à vérifier:');
  for (const f of failed) console.log(`  • ${f.label}: ${f.detail}`);
  process.exit(1);
}
console.log('\n✅ Slack Kisso Ind prêt pour l’onboarding.\n');
console.log('Prochaine étape mapping: note les channel IDs ci-dessus dans .env / config.');
console.log('Ex: SLACK_CHANNEL_ENGINEERING=C0…\n');
