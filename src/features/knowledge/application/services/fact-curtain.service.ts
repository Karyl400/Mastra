import { logger } from '../../../../shared/logger';
import { sanitizeNotificationBody } from '../../../../shared/security/agent-output';
import {
  FACT_SUMMARY_MAX_CHARS,
  KNOWLEDGE_FACT_MIN_SCORE,
  type FactKind,
} from '../../domain/services/fact-distillation';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import type { MessageArchiveRepository } from '../../domain/ports/message-archive.repository';
import type { FactSummarizerPort } from '../../domain/ports/fact-summarizer.port';

/**
 * Le lot demandé par le propriétaire : cinq messages. Assez pour que le modèle voie un fil de
 * conversation plutôt que des phrases isolées, assez peu pour qu'un lot tienne largement dans
 * une fenêtre et coûte un aller-retour, pas dix.
 */
export const CURTAIN_BATCH_SIZE = 5;

/**
 * ⚠️ **LA FENÊTRE EST LA BORNE QUI COMPTE.** Allumer un rideau réveille tout ce qui dormait —
 * leçon payée le même jour sur les rappels, où la première exécution du cron a remis des
 * lignes écrites des semaines plus tôt. Sans fenêtre, brancher ce service sur une archive
 * fournie enverrait tout l'historique au modèle, par lots de cinq, jusqu'à épuisement.
 */
export const CURTAIN_WINDOW_MS = 6 * 60 * 60 * 1000;

const KNOWN_KINDS: ReadonlySet<string> = new Set<FactKind>([
  'decision',
  'engagement',
  'blocage',
  'echeance',
  'question',
]);

export interface FactCurtainDeps {
  readonly archive: MessageArchiveRepository;
  readonly facts: KnowledgeFactRepository;
  readonly summarizer: FactSummarizerPort;
  readonly now?: () => number;
}

export interface CurtainReport {
  readonly examined: number;
  readonly recorded: number;
  readonly rejected: number;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE SECOND RIDEAU — code d'abord, modèle en rattrapage
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ne tourne QUE lorsque cinq messages se sont accumulés sans qu'aucun motif déterministe n'ait
 * mordu. Sur le chemin nominal — le code classe — il ne coûte rien du tout.
 *
 * ⚠️ **TOUT LE LOT EST MARQUÉ, y compris ce dont le modèle n'a rien tiré.** Sans cela, cinq
 * messages sans intérêt seraient relus à chaque nouveau message : un appel de modèle par
 * message, c'est-à-dire l'inverse exact de ce que le lot de cinq existe pour éviter.
 *
 * ⚠️ **ET ILS SONT MARQUÉS MÊME SI LE MODÈLE ÉCHOUE.** Un modèle indisponible ne doit pas
 * transformer le rideau en boucle de réessai sur les mêmes cinq lignes. Ce qu'on perd est une
 * distillation, et le niveau 1 garde le message : la recherche dégrade vers le texte brut,
 * exactement comme quand `distillFact` ne trouve rien.
 */
export async function runFactCurtain(deps: FactCurtainDeps): Promise<CurtainReport> {
  const now = deps.now?.() ?? Date.now();

  const pending = await deps.archive.pendingDistillation(CURTAIN_WINDOW_MS, CURTAIN_BATCH_SIZE);
  if (pending.length < CURTAIN_BATCH_SIZE) {
    return { examined: 0, recorded: 0, rejected: 0 };
  }

  const byId = new Map(pending.map((message) => [message.id, message]));

  let summarized: readonly { id: string; kind: string; summary: string }[];
  try {
    summarized = await deps.summarizer.summarize(
      pending.map((message) => ({ id: message.id, text: message.text })),
    );
  } catch (error) {
    logger.warn('Second rideau — modèle indisponible, le lot est marqué et le niveau 1 tient', {
      batch: pending.length,
      error: String(error),
    });
    await deps.archive.markDistilled([...byId.keys()], now);
    return { examined: pending.length, recorded: 0, rejected: 0 };
  }

  let recorded = 0;
  let rejected = 0;

  for (const candidate of summarized) {
    const source = byId.get(candidate.id);

    // ⚠️ Un identifiant que le modèle a INVENTÉ ne doit pas créer une ligne : le fait serait
    // rattaché à un canal et à une personne choisis par lui.
    if (!source) {
      rejected += 1;
      continue;
    }

    if (!KNOWN_KINDS.has(candidate.kind)) {
      rejected += 1;
      continue;
    }

    // ⚠️ La sortie du modèle est de la DONNÉE, pas de la prose de confiance : elle a été
    // produite à partir de messages Slack, la surface d'injection la plus directe du produit.
    // Un marqueur interne recopié dans un `summary` ressortirait tel quel à la première
    // recherche — le contournement exact du filtre unique corrigé sur les documents le
    // 2026-08-11.
    const safe = sanitizeNotificationBody(candidate.summary);
    const summary = safe.text.trim().slice(0, FACT_SUMMARY_MAX_CHARS);

    if (safe.redacted.length > 0 || safe.strippedUrls.length > 0) {
      logger.error('Second rideau — sortie du modèle assainie avant stockage', {
        redacted: safe.redacted,
        strippedUrls: safe.strippedUrls,
      });
    }

    if (summary.length === 0) {
      rejected += 1;
      continue;
    }

    try {
      await deps.facts.record({
        id: source.id,
        channelId: source.channelId,
        slackUserId: source.slackUserId,
        kind: candidate.kind as FactKind,
        summary,
        // Le score du rideau est le PLANCHER : ce que le code n'a pas su classer ne doit pas
        // passer devant ce qu'il a classé avec certitude.
        score: KNOWLEDGE_FACT_MIN_SCORE,
        postedAt: source.postedAt,
      });
      recorded += 1;
    } catch (error) {
      rejected += 1;
      logger.warn('Second rideau — fait non enregistré', { id: source.id, error: String(error) });
    }
  }

  await deps.archive.markDistilled([...byId.keys()], now);

  logger.info('Second rideau passé', { examined: pending.length, recorded, rejected });

  return { examined: pending.length, recorded, rejected };
}
