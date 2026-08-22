/**
 * Envoie le formulaire « Compléter mon profil » aux personnes qui n'ont pas de dossier.
 *
 * ── Le trou qu'il rattrape ──────────────────────────────────────────────────
 * Le bouton n'avait qu'un seul émetteur, `handleTeamJoin`, et cet événement n'est même pas
 * abonné côté app Slack. Personne n'a donc jamais reçu ce DM, et `employees` ne s'est
 * rempli que par les rares soumissions manuelles.
 *
 * Relevé sur la Turso de production le 2026-08-14 :
 *   employees        = 2 lignes (Karyl, Awa)
 *   slack_directory  = 40 lignes, dont 4 personnes vivantes non rattachées
 *                      (Nazer, Pamela, Mistourath, ridwanenico77)
 *
 * Ce script fait, une fois, ce que `team_join` aurait dû faire à chaque arrivée. Le
 * court-circuit « compléter mon profil » (`src/shared/profile-request.ts`) couvre ensuite
 * le cas courant, à la demande.
 *
 * ── Pourquoi il n'écrit AUCUNE ligne `employees` ────────────────────────────
 * La tentation évidente serait de créer les fiches manquantes depuis l'annuaire. Elle est
 * écartée : `position` et `start_date` sont `NOT NULL` et l'annuaire ne les connaît pas —
 * `title` est le poste DÉCLARÉ dans Slack, souvent vide (22 lignes sur 40 en production),
 * et la date d'arrivée n'existe nulle part. Les fabriquer produirait exactement le défaut
 * que ce dépôt combat : une valeur inventée qu'un lecteur ultérieur relit comme un fait.
 *
 * La donnée vient de la personne. Ce script ne fait que lui poser la question.
 *
 * ── Sûreté ──────────────────────────────────────────────────────────────────
 *  • DRY-RUN PAR DÉFAUT : sans `--apply`, pas un seul message envoyé.
 *  • Bots, comptes désactivés et personnes DÉJÀ rattachées (`employee_id` non nul) sont
 *    écartés — on n'écrit pas à quelqu'un dont le dossier est complet.
 *  • Chaque échec est isolé : un DM refusé n'interrompt pas les suivants.
 *
 * ⚠️ NON IDEMPOTENT au sens strict. Relancer avec `--apply` renvoie le message à ceux qui
 * n'ont toujours pas rempli le formulaire — c'est voulu (c'est une relance), mais ce n'est
 * pas anodin : chaque exécution est visible par des humains. Vérifier le dry-run d'abord.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *     npx tsx --env-file=.env scripts/invite-profile-completion.mts           # dry-run
 *     npx tsx --env-file=.env scripts/invite-profile-completion.mts --apply   # envoie
 */

import 'dotenv/config';

import { DrizzleDirectoryRepository } from '../src/features/directory/infrastructure/repositories/drizzle-directory.repository';
import { SlackAdapter } from '../src/features/notification/infrastructure/providers/slack.adapter';
import {
  SLACKBOT_USER_ID,
  buildProfileInviteBlocks,
} from '../src/features/notification/infrastructure/handlers/slack-events.handler';
import { PROFILE_FORM_INVITE } from '../src/shared/profile-request';
import { errorMessage } from '../src/shared/errors';
import type { DirectoryMember } from '../src/features/directory/domain/entities/directory-member';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

/**
 * Qui doit recevoir le formulaire ?
 *
 * Fonction PURE et exportée : c'est la seule règle du script, et la seule chose qui mérite
 * d'être vérifiable sans toucher ni Slack ni la base.
 */
export function needsProfileForm(member: DirectoryMember): boolean {
  if (member.isBot || member.isDeleted) return false;
  // ⚠️ Slackbot n'est déclaré NI `is_bot` NI `deleted` par `users.list` — vérifié sur la
  // production, sa ligne porte `is_bot=0, is_deleted=0`. Les deux filtres ci-dessus le
  // laissent donc passer, et le dry-run du 2026-08-14 le listait bel et bien parmi les
  // personnes à relancer.
  if (member.slackUserId === SLACKBOT_USER_ID) return false;
  // Déjà rattaché à une fiche `employees` : le dossier existe, rien à demander.
  if (member.employeeId) return false;
  return true;
}

function displayOf(member: DirectoryMember): string {
  return (
    member.displayName ||
    member.realName ||
    [member.firstName, member.lastName].filter(Boolean).join(' ') ||
    member.slackUserId
  );
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN est requis.');

  const directory = new DrizzleDirectoryRepository();
  const slack = new SlackAdapter(token);

  const all = await directory.listAll();
  const targets = all.filter(needsProfileForm);

  console.log(`Annuaire : ${all.length} lignes, ${targets.length} sans dossier d'onboarding.`);

  if (targets.length === 0) {
    console.log('Personne à relancer.');
    return;
  }

  console.log('\n  personne                        slack user     email');
  for (const member of targets) {
    console.log(
      `  ${displayOf(member).padEnd(30).slice(0, 30)}  ${member.slackUserId.padEnd(13)}  ${
        member.email ?? '—'
      }`,
    );
  }

  if (!apply) {
    console.log(
      `\nRien n’a été envoyé. Relancer avec --apply pour écrire à ces ${targets.length} personnes.`,
    );
    return;
  }

  let sent = 0;
  const failures: Array<{ slackUserId: string; error: string }> = [];

  for (const member of targets) {
    try {
      /**
       * `sendBlocks` accepte un identifiant `U…` : Slack ouvre alors le DM.
       *
       * ⚠️ **PLUS AUCUN PRÉ-REMPLISSAGE, et le commentaire qui figurait ici affirmait le
       * contraire.** Il disait « le pré-remplissage vient de l'annuaire, exactement comme dans
       * le court-circuit », et un objet de quatre champs était passé à
       * `buildProfileInviteBlocks`. Or cette fonction ne prend **aucun argument** depuis la
       * suppression des modales le 2026-08-19 : le pré-remplissage vivait dans le `value` du
       * bouton, et il n'y a plus de bouton. JavaScript ignore silencieusement les arguments en
       * trop — le script fonctionnait donc, en envoyant une invitation générique, pendant que
       * son commentaire décrivait autre chose.
       *
       * ⚠️ **Rien ne l'a signalé pendant deux jours** parce que `scripts/` était hors de
       * `tsconfig.include` : `tsc` ne l'a jamais lu. C'est la raison pour laquelle ce
       * répertoire y est entré le 2026-08-21 — 8 146 lignes dont douze fichiers écrivent en
       * production, et cette erreur-là a été trouvée dans la minute qui a suivi.
       *
       * L'accueil recueille désormais prénom, nom et email par l'ÉCHANGE ÉCRIT
       * (`profile-chat.ts`), qui lit l'annuaire côté serveur. Rien n'est perdu.
       */
      await slack.sendBlocks(member.slackUserId, PROFILE_FORM_INVITE, buildProfileInviteBlocks());
      sent += 1;
    } catch (error) {
      // Isolé : un DM refusé (compte restreint, canal fermé) ne doit pas priver les autres
      // de leur formulaire.
      failures.push({
        slackUserId: member.slackUserId,
        error: errorMessage(error),
      });
    }
  }

  console.log(`\nEnvoyés : ${sent}/${targets.length}`);
  for (const failure of failures) {
    console.log(`  ÉCHEC ${failure.slackUserId} — ${failure.error}`);
  }
}

main().catch((error) => {
  console.error('Invitation interrompue :', error);
  process.exit(1);
});
