/**
 * Synchronisation de l'annuaire Slack et couverture des canaux.
 *
 * ── Ce qu'il fait ───────────────────────────────────────────────────────────
 *  1. Lit TOUT le workspace (`users.list`, paginé et borné) et enregistre chaque personne
 *     dans `slack_directory` — bots, invités et comptes désactivés COMPRIS : ce sont
 *     exactement les faits sur lesquels la politique d'autorisation refuse ou rétrograde.
 *  2. Rattache `employee_id` quand l'email désigne un employé enregistré.
 *  3. Rejoint les canaux PUBLICS où le bot n'est pas membre (`conversations.join`), et
 *     rapporte par Channel ID ceux où il peut désormais écrire.
 *  4. Enregistre l'INVENTAIRE des canaux — `slack_channels` (ID, nom, public/privé, archivé,
 *     membre, `num_members` tel qu'affirmé par Slack) et `slack_channel_members` (les membres
 *     observés de chaque canal où le bot peut écrire).
 *
 * ⚠️ L'inventaire est de l'OBSERVABILITÉ, JAMAIS de l'autorisation. Aucun événement Slack ne
 * l'invalide : `member_joined_channel` et `member_left_channel` ne sont pas abonnés (liste
 * faisant foi : `CLAUDE.md`, section « ABONNEMENTS »). Ces lignes sont
 * donc fausses et silencieuses dès qu'une personne quitte un canal entre deux passages de ce
 * script. Voir `src/features/directory/domain/entities/slack-channel.ts`.
 *
 * ── Pourquoi un script, et pas un appel au démarrage ────────────────────────
 * Le boot d'une fonction Vercel est SUR le chemin des 3 secondes d'ACK de Slack. Un balayage
 * complet du workspace y ajouterait plusieurs appels HTTP à chaque démarrage à froid — et un
 * ACK à 6,7 s a déjà provoqué en production un rejeu Slack, donc une DOUBLE réponse. La
 * synchronisation complète est donc manuelle ou périodique ; la connaissance au fil de l'eau,
 * elle, se fait par `MemberSource.fetchById` sur le chemin du message.
 *
 * ── Sûreté ──────────────────────────────────────────────────────────────────
 *  • DRY-RUN PAR DÉFAUT : sans `--apply`, pas une écriture en base ni un seul
 *    `conversations.join`.
 *  • IDEMPOTENT : relancer ne produit rien de neuf. `upsertFacts` ne touche jamais
 *    `dm_channel_id`, `employee_id` ni `first_seen_at`, et un canal déjà rejoint n'est pas
 *    retenté.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npx tsx scripts/sync-slack-directory.mts                # dry-run (défaut)
 *     npx tsx scripts/sync-slack-directory.mts --apply        # écrit et rejoint réellement
 *     npx tsx scripts/sync-slack-directory.mts --members      # annuaire seulement
 *     npx tsx scripts/sync-slack-directory.mts --channels     # canaux seulement
 *
 * ⚠️ La table `slack_directory` doit exister : `scripts/ddl-slack-directory.sql`. Sans elle,
 * chaque ligne échoue avec `no such table: slack_directory` — le rapport le nomme.
 *
 * ⚠️ Les tables `slack_channels` et `slack_channel_members` doivent exister :
 * `scripts/ddl-slack-channels.sql`. Sans elles, la couverture de canaux (`conversations.join`)
 * continue de fonctionner — l'inventaire est une dépendance OPTIONNELLE du service — mais chaque
 * canal apparaît en échec d'inventaire avec `no such table: slack_channels`.
 *
 *     npx tsx --env-file=.env scripts/apply-ddl.mts scripts/ddl-slack-channels.sql
 */

import 'dotenv/config';

import { SlackWorkspaceService } from '../src/features/notification/infrastructure/providers/slack-workspace.service';
import { DrizzleDirectoryRepository } from '../src/features/directory/infrastructure/repositories/drizzle-directory.repository';
import { DrizzleEmployeeRepository } from '../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { SlackMemberSource } from '../src/features/directory/infrastructure/providers/slack-member-source.adapter';
import { SlackChannelAccess } from '../src/features/directory/infrastructure/providers/slack-channel-access.adapter';
import { DrizzleChannelInventoryRepository } from '../src/features/directory/infrastructure/repositories/drizzle-channel.repository';
import { InMemoryChannelInventoryRepository } from '../src/features/directory/infrastructure/repositories/in-memory-channel.repository';
import { makeDirectorySync } from '../src/features/directory/application/services/directory-sync.service';
import {
  makeChannelCoverage,
  type ChannelAccessSource,
} from '../src/features/directory/application/services/channel-coverage.service';
import type { DirectoryRepository } from '../src/features/directory/domain/ports/directory.repository';
import type { ChannelInventoryRepository } from '../src/features/directory/domain/ports/channel.repository';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const onlyMembers = args.has('--members');
const onlyChannels = args.has('--channels');
const doMembers = !onlyChannels;
const doChannels = !onlyMembers;

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('SLACK_BOT_TOKEN manquant — rien à synchroniser.');
  process.exit(1);
}

const slack = new SlackWorkspaceService(token);

/**
 * Annuaire en LECTURE SEULE pour le dry-run.
 *
 * Les lectures sont RÉELLES : c'est ce qui permet de dire « ces 3 personnes seraient
 * rattachées » plutôt que « 42 personnes seraient écrites ». Seules les écritures sont
 * neutralisées, et elles le sont au plus près du port — un `if (apply)` semé dans le service
 * ferait diverger le chemin mesuré du chemin exécuté, exactement ce que le mode observation de
 * la politique d'autorisation évite.
 */
function readOnly(repository: DirectoryRepository): DirectoryRepository {
  return {
    findBySlackUserId: (id) => repository.findBySlackUserId(id),
    findByEmail: (email) => repository.findByEmail(email),
    listAll: () => repository.listAll(),
    upsertFacts: async () => {},
    rememberDmChannel: async () => {},
    linkEmployee: async () => {},
  };
}

/**
 * Couverture simulée : aucun `conversations.join` n'est émis.
 *
 * `listMembers` est en revanche RÉELLE — c'est une LECTURE. C'est elle qui permet au dry-run de
 * dire « ce canal a 6 membres, les voici » plutôt que « des membres seraient enregistrés ».
 */
function withoutJoining(source: ChannelAccessSource): ChannelAccessSource {
  return {
    listChannels: () => source.listChannels(),
    join: async () => ({ status: 'joined' as const }),
    listMembers: source.listMembers ? (id: string) => source.listMembers!(id) : undefined,
  };
}

async function main(): Promise<void> {
  console.log(apply ? '── MODE APPLY — écritures réelles ──' : '── DRY-RUN — aucune écriture ──');

  if (doMembers) {
    const repository = new DrizzleDirectoryRepository();
    const source = new SlackMemberSource(slack);

    const sync = makeDirectorySync({
      source,
      repository: apply ? repository : readOnly(repository),
      employees: new DrizzleEmployeeRepository(),
    });

    const report = await sync.run();
    console.log('\nANNUAIRE');
    console.log(`  verdict         : ${report.outcome}`);
    console.log(`  membres lus     : ${report.scanned}${report.truncated ? ' (TRONQUÉ)' : ''}`);
    console.log(`  enregistrés     : ${report.upserted}${apply ? '' : ' (simulé)'}`);
    console.log(`  rattachés       : ${report.linked}${apply ? '' : ' (simulé)'}`);
    if (report.failureCount > 0) {
      console.log(`  ÉCHECS          : ${report.failureCount}`);
      for (const failure of report.failures) {
        console.log(`    - ${failure.slackUserId} : ${failure.error}`);
      }
    }
  }

  if (doChannels) {
    // `reportedMemberCounts` coûte un SECOND `conversations.list` : on l'active ici, dans un
    // script manuel, et jamais dans le câblage de `src/mastra/index.ts` — celui-là est
    // atteignable au boot d'une fonction Vercel, sur le chemin des 3 s d'ACK de Slack.
    const access = new SlackChannelAccess(slack, { reportedMemberCounts: true });

    // En dry-run, l'inventaire est écrit dans une doublure EN MÉMOIRE plutôt que neutralisé :
    // le rapport montre alors exactement ce qui SERAIT enregistré, canal par canal, sans
    // toucher la base. Un `upsert` transformé en fonction vide n'aurait rien montré du tout.
    const inventory: ChannelInventoryRepository = apply
      ? new DrizzleChannelInventoryRepository()
      : new InMemoryChannelInventoryRepository();

    const coverage = makeChannelCoverage({
      source: apply ? access : withoutJoining(access),
      inventory,
    });

    const report = await coverage.run();
    console.log('\nCANAUX');
    console.log(`  verdict         : ${report.outcome}`);
    console.log(`  canaux lus      : ${report.scanned}${report.truncated ? ' (TRONQUÉ)' : ''}`);
    console.log(`  déjà membre     : ${report.alreadyMember}`);
    console.log(
      `  ${apply ? 'rejoints       ' : 'à rejoindre    '} : ${report.joined.length}` +
        (report.joined.length ? ` — ${report.joined.map((c) => `#${c.name}`).join(', ')}` : ''),
    );
    if (report.privateNotMember.length > 0) {
      // État NOMMÉ, pas un échec : un canal privé exige une invitation humaine.
      console.log(
        `  privés (invitation humaine requise) : ${report.privateNotMember
          .map((c) => `#${c.name}`)
          .join(', ')}`,
      );
    }
    if (report.archivedSkipped > 0) console.log(`  archivés ignorés: ${report.archivedSkipped}`);
    if (report.missingScope) {
      console.log(
        '  ⚠️ SCOPE `channels:join` MANQUANT — ajouter le scope dans OAuth & Permissions,\n' +
          '     PUIS réinstaller l’app : l’ajout seul ne propage rien.',
      );
    }
    console.log(`  accessibles     : ${report.accessibleChannelIds.join(', ') || '(aucun)'}`);

    if (report.inventory) {
      const inv = report.inventory;
      console.log('\nINVENTAIRE');
      console.log(`  canaux enregistrés : ${inv.channelsRecorded}${apply ? '' : ' (simulé)'}`);
      console.log(`  canaux énumérés    : ${inv.channelsWithMembers}`);
      console.log(`  appartenances      : ${inv.membersRecorded}${apply ? '' : ' (simulé)'}`);

      if (inv.truncatedChannels.length > 0) {
        // Un plafond silencieux se lit « tout est synchronisé » : il est donc dit.
        console.log(`  ⚠️ TRONQUÉS        : ${inv.truncatedChannels.join(', ')}`);
      }
      if (inv.failures.length > 0) {
        console.log(`  ÉCHECS             : ${inv.failures.length}`);
        for (const failure of inv.failures) {
          console.log(`    - #${failure.name} (${failure.channelId}) : ${failure.error}`);
        }
      }

      // Le détail par canal. `observé` est LE compte ; `slack dit` est l'assertion de
      // `conversations.list` (`num_members`), lue à un AUTRE instant. Les deux colonnes restent
      // séparées : leur écart est le seul signal de fraîcheur d'un inventaire qu'aucun événement
      // Slack ne vient démentir (`member_joined_channel` n'est pas abonné).
      const entries = await inventory.listInventory();
      if (entries.length > 0) {
        console.log('\n  canal                          membre  observé  slack dit');
        for (const { channel, observedMemberCount } of entries) {
          const label = `#${channel.name}`.padEnd(24).slice(0, 24);
          const id = channel.channelId.padEnd(13);
          const member = channel.isMember ? 'oui   ' : 'non   ';
          const reported = channel.memberCountReported ?? '—';
          console.log(
            `  ${label} ${id}  ${member}  ${String(observedMemberCount).padStart(5)}  ${String(reported).padStart(8)}`,
          );
        }
      }
    }
  }

  if (!apply) {
    console.log('\nRien n’a été écrit. Relancer avec --apply pour appliquer.');
  }
}

main().catch((error) => {
  console.error('Synchronisation interrompue :', error);
  process.exit(1);
});
