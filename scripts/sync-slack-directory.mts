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
 */

import 'dotenv/config';

import { SlackWorkspaceService } from '../src/features/notification/infrastructure/providers/slack-workspace.service';
import { DrizzleDirectoryRepository } from '../src/features/directory/infrastructure/repositories/drizzle-directory.repository';
import { DrizzleEmployeeRepository } from '../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { SlackMemberSource } from '../src/features/directory/infrastructure/providers/slack-member-source.adapter';
import { SlackChannelAccess } from '../src/features/directory/infrastructure/providers/slack-channel-access.adapter';
import { makeDirectorySync } from '../src/features/directory/application/services/directory-sync.service';
import {
  makeChannelCoverage,
  type ChannelAccessSource,
} from '../src/features/directory/application/services/channel-coverage.service';
import type { DirectoryRepository } from '../src/features/directory/domain/ports/directory.repository';

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

/** Couverture simulée : aucun `conversations.join` n'est émis. */
function withoutJoining(source: ChannelAccessSource): ChannelAccessSource {
  return {
    listChannels: () => source.listChannels(),
    join: async () => ({ status: 'joined' as const }),
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
    const access = new SlackChannelAccess(slack);
    const coverage = makeChannelCoverage({ source: apply ? access : withoutJoining(access) });

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
  }

  if (!apply) {
    console.log('\nRien n’a été écrit. Relancer avec --apply pour appliquer.');
  }
}

main().catch((error) => {
  console.error('Synchronisation interrompue :', error);
  process.exit(1);
});
