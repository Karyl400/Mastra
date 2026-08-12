import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext } from '../../../../shared/slack-request-context';
import {
  readOrgEmailDomains,
  type AccessPolicyConfig,
} from '../../../directory/domain/services/access-policy';
import type { ConversationExcerpt } from '../../domain/entities/conversation-excerpt';
import type { BotMemoryReadPort } from '../../domain/ports/bot-memory.repository';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../domain/ports/person-directory.port';
import {
  authorizeMemoryRead,
  type DisclosureReason,
  type Requester,
} from '../../domain/services/disclosure-policy';
import { projectExcerpts } from '../../domain/services/excerpt-budget';
import {
  KNOWLEDGE_LOOKBACK_MS,
  KNOWLEDGE_SCAN_LIMIT,
} from '../../domain/value-objects/retrieval-window';
import { wrapRetrievedContent } from '../services/untrusted-excerpt.service';

/**
 * `getUserConversations` — ce qu'une personne a échangé EN DIRECT avec le bot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LA SOURCE, ET SA FRONTIÈRE
 * ────────────────────────────────────────────────────────────────────────────
 * Uniquement la table `conversation_turns`, et uniquement la conversation dont
 * la clé est un canal `D…`. Le raisonnement complet est dans
 * `domain/ports/bot-memory.repository.ts` : les fils de canal vivent dans la
 * même table, sous une clé `C…:ts`, et les servir ici contournerait le contrôle
 * d'appartenance qui protège l'autre porte.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ CE TOOL REFUSE HORS SLACK — À L'INVERSE DE TOUS LES AUTRES
 * ────────────────────────────────────────────────────────────────────────────
 * `readSlackContext` rend `undefined` dans le playground Mastra, sur une route
 * HTTP, dans un workflow et dans un test : c'est le cas NORMAL de ces chemins, et
 * la doctrine du dépôt y est la DÉGRADATION (`generateDocument` enregistre sans
 * livrer, et le dit).
 *
 * Ici, dégrader signifierait rendre l'intégralité des conversations lisible
 * depuis un chemin sans demandeur, donc sans authentification. Pas de
 * demandeur ⇒ pas de droits ⇒ rien à divulguer. Le refus n'est pas une panne :
 * il est rendu comme un verdict lisible, avec son motif.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SCHÉMA : UN SEUL CHAMP, ET IL EST FACULTATIF
 * ────────────────────────────────────────────────────────────────────────────
 * Le poste de coût dominant n'est pas la taille du prompt mais le NOMBRE
 * D'ÉTAPES : chaque question posée à l'humain est un aller-retour complet chez
 * les deux fournisseurs. `sendNotification` est passé de 5 champs obligatoires à
 * 3 et c'est ce qui l'a débloqué ; `generateDocument`, seul outil de la campagne
 * qui ait abouti, avait ce profil.
 *
 * D'où : zéro champ obligatoire. Sans valeur, c'est l'interlocuteur lui-même —
 * le cas le plus fréquent, servi sans un mot échangé. Et un champ UNIQUE qui
 * accepte l'email comme l'identifiant Slack, plutôt que deux champs entre
 * lesquels le modèle devrait arbitrer.
 */

/** Ce que le tool a besoin de savoir faire, et rien de plus. */
export interface GetUserConversationsDeps {
  readonly directory: PersonDirectoryPort;
  readonly memory: BotMemoryReadPort;
  /**
   * Injectable pour les tests. En production, lue depuis `SLACK_ORG_EMAIL_DOMAINS`
   * À CHAQUE APPEL — et non figée à la construction : le câblage a lieu à
   * l'import de `src/mastra/index.ts`, or une variable absente donnerait alors
   * une politique vide gelée pour la vie du processus.
   */
  readonly policy?: AccessPolicyConfig;
}

/** Un `U…`. Slack les écrit en majuscules ; on tolère la saisie humaine. */
const SLACK_USER_ID_RE = /^U[A-Z0-9]{4,}$/i;

/**
 * Verdicts rendus au modèle. Ils NOMMENT la règle, jamais la donnée.
 *
 * `person_not_found` et `no_recorded_conversation` sont distincts à dessein :
 * `getTaskList` rendait `{tasks: [], total: 0}` pour un identifiant qui ne
 * désignait personne, et le modèle en concluait « aucune tâche en cours ». Un
 * « rien trouvé » ambigu produit une affirmation fausse, pas un doute.
 */
type MemoryVerdict =
  | DisclosureReason
  | 'person_not_resolved'
  | 'person_not_found'
  | 'no_recorded_conversation'
  | 'memory_unavailable';

/**
 * Consignes rendues UNIQUEMENT dans les cas dégradés — jamais dans le cas
 * passant, où elles seraient repayées à chaque aller-retour pour rien (même
 * arbitrage que le `hint` de `generateDocument`).
 *
 * Elles disent à l'agent quoi RÉPONDRE, pas quoi penser : sans elles, un tool
 * qui échoue laisse l'espace négatif vide, et le modèle le comble par une règle
 * métier inventée.
 */
const VERDICT_HINTS: Partial<Record<MemoryVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  insufficient_privilege: 'Tu ne peux montrer que les échanges de la personne qui te parle.',
  requester_denied: 'Compte non autorisé.',
  person_not_resolved: 'Demande un email ou un identifiant Slack (U…).',
  person_not_found: "Personne inconnue de l'annuaire.",
  no_recorded_conversation: "Cette personne n'a jamais échangé en direct avec toi.",
  memory_unavailable: 'Mémoire indisponible. Réessayer a un sens.',
};

function refuse(reason: MemoryVerdict) {
  const hint = VERDICT_HINTS[reason];
  return hint ? { found: false as const, reason, hint } : { found: false as const, reason };
}

/**
 * Résout la personne visée. Un identifiant Slack et un email sont deux formes
 * si différentes qu'aucune ambiguïté n'est possible — inutile de faire trancher
 * le modèle par un second champ.
 */
async function resolveTarget(
  directory: PersonDirectoryPort,
  raw: string,
): Promise<DirectoryPerson | null | 'unparsable'> {
  const value = raw.trim();

  if (SLACK_USER_ID_RE.test(value)) return directory.findBySlackUserId(value.toUpperCase());
  if (value.includes('@')) return directory.findByEmail(value.toLowerCase());

  // Un nom, un prénom, un surnom : l'annuaire n'a pas d'index dessus, et deviner
  // serait pire que refuser — on désignerait la mauvaise personne en silence.
  return 'unparsable';
}

export function makeGetUserConversations(deps: GetUserConversationsDeps) {
  return createTool({
    id: 'getUserConversations',
    description: 'Retrouve les échanges directs entre cette personne et toi.',
    inputSchema: z.object({
      person: z
        .string()
        .trim()
        .min(1)
        .max(254)
        .optional()
        .describe('Email ou identifiant Slack. Vide = la personne qui te parle.'),
    }),
    execute: async (data, ctx) => {
      const policy: AccessPolicyConfig = deps.policy ?? {
        orgEmailDomains: readOrgEmailDomains(process.env.SLACK_ORG_EMAIL_DOMAINS),
      };

      const slack = readSlackContext(ctx?.requestContext);
      if (!slack?.slackUserId) {
        logger.warn('Knowledge — récupération refusée : aucun demandeur identifié', {
          scope: 'bot_memory',
        });
        return refuse('no_requester');
      }

      const requesterId = slack.slackUserId;

      // Une panne d'annuaire ne doit pas casser la réponse : le demandeur reste
      // identifié (donc il lit ses propres échanges), mais n'obtient aucun
      // privilège. Monotone restrictif — même doctrine que `SlackAccessGuard`.
      let requesterPerson: DirectoryPerson | null = null;
      try {
        requesterPerson = await deps.directory.findBySlackUserId(requesterId);
      } catch (error) {
        logger.warn('Knowledge — annuaire indisponible, demandeur traité comme inconnu', {
          requesterId,
          error,
        });
      }

      const requester: Requester = { slackUserId: requesterId, subject: requesterPerson };

      const asked = data.person?.trim();
      const resolved = asked ? await resolveTarget(deps.directory, asked) : requesterPerson;

      if (resolved === 'unparsable') return refuse('person_not_resolved');

      // Cas particulier utile : le demandeur nous écrit en DM et l'annuaire ne le
      // connaît pas encore. Le canal courant EST sa conversation — la refuser
      // reviendrait à lui cacher ce qu'il vient lui-même d'écrire.
      const targetId = resolved?.slackUserId ?? (asked ? null : requesterId);
      if (!targetId) return refuse('person_not_found');

      const verdict = authorizeMemoryRead(requester, targetId, policy);
      if (!verdict.allowed) {
        logger.warn('Knowledge — récupération refusée par la politique de divulgation', {
          scope: 'bot_memory',
          requesterId,
          targetId,
          reason: verdict.reason,
        });
        return refuse(verdict.reason);
      }

      const isSelf = targetId === requesterId;
      const dmChannelId =
        resolved?.dmChannelId ?? (isSelf && slack.channel.startsWith('D') ? slack.channel : null);

      // ⚠️ L'invariant du port, vérifié côté appelant AUSSI : seule une clé `D…`
      // désigne une conversation directe. Une clé de fil (`C…:1734…`) servirait
      // du contenu de canal sans contrôle d'appartenance.
      if (!dmChannelId || !dmChannelId.startsWith('D')) {
        return refuse('no_recorded_conversation');
      }

      let turns;
      try {
        turns = await deps.memory.recentDirectTurns(dmChannelId, {
          sinceMs: KNOWLEDGE_LOOKBACK_MS,
          limit: KNOWLEDGE_SCAN_LIMIT,
        });
      } catch (error) {
        logger.error('Knowledge — lecture de la mémoire du bot en échec', {
          requesterId,
          targetId,
          error,
        });
        return refuse('memory_unavailable');
      }

      if (turns.length === 0) return refuse('no_recorded_conversation');

      const speaker = resolved?.displayName || targetId;
      const excerpts: ConversationExcerpt[] = turns.map((turn) => ({
        source: 'bot_memory',
        // « Kisso » et non l'identifiant de l'agent : le nom de l'agent est un
        // détail d'implémentation, et les tours viennent parfois d'agents
        // différents — le distinguer ici ferait payer une information qui
        // n'éclaire pas la question posée.
        speaker: turn.role === 'assistant' ? 'Kisso' : speaker,
        text: turn.text,
        at: turn.at,
      }));

      const { lines, shown } = projectExcerpts(excerpts);

      // JOURNALISATION RGPD : qui a lu quoi, quand, et sur quelle base. Jamais le
      // contenu — une trace d'accès qui recopie la donnée devient elle-même la
      // fuite qu'elle documente.
      logger.info('Knowledge — récupération de conversations directes', {
        scope: 'bot_memory',
        requesterId,
        targetId,
        reason: verdict.reason,
        scanned: turns.length,
        shown,
      });

      return {
        found: true,
        // Le contenu ne sort JAMAIS de ce bloc : c'est la seule chose qui
        // distingue « une donnée qu'on te montre » de « une instruction qu'on te
        // donne ». Voir `services/untrusted-excerpt.service.ts`.
        conversation: wrapRetrievedContent(lines),
        shown,
        scanned: turns.length,
      };
    },
  });
}
