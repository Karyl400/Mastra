import { logger } from '../../../../shared/logger';
import type {
  ForgetScope,
  MessageArchiveRepository,
} from '../../domain/ports/message-archive.repository';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'EFFACEMENT DE L'ARCHIVE — le geste qui manquait à un droit annoncé
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `ERASURE_SCOPE_NOTICE` disait, honnêtement, que les messages archivés dans les canaux
 * « ne passent pas par moi » et renvoyait vers le General Manager. C'était vrai et ce n'était
 * pas suffisant : **le General Manager n'avait aucun moyen d'exécuter la demande.** Pas de
 * script, pas de route, pas de commande — il aurait dû écrire du SQL à la main sur la Turso de
 * production. Un renvoi vers un geste sans implémentation.
 *
 * ⚠️ **LES DEUX TABLES PARTENT ENSEMBLE, ET C'EST LE POINT.** `knowledge_facts` est DÉRIVÉE de
 * `channel_messages` : effacer l'une sans l'autre laisserait un résumé sans son message source,
 * que `searchKnowledge` continuerait de rendre. C'est le pire des deux moitiés — la trace
 * disparaît, l'affirmation reste. Ce service existe pour qu'on ne puisse plus en oublier une.
 *
 * ⚠️ **On efface les FAITS D'ABORD.** Si la seconde suppression échoue, l'état intermédiaire
 * est « les messages sont encore là, les faits sont partis » — récupérable en rejouant la
 * distillation. Dans l'autre ordre, l'état intermédiaire serait « les faits parlent de messages
 * qui n'existent plus », c'est-à-dire une affirmation sans source, impossible à réparer
 * autrement qu'en effaçant à nouveau.
 */
export interface KnowledgeErasurePort {
  forget(scope: ForgetScope): Promise<KnowledgeErasureReport>;
}

export interface KnowledgeErasureReport {
  readonly messages: number;
  readonly facts: number;
  /** Vrai si l'une des deux suppressions a échoué : l'appelant ne doit alors JAMAIS dire « effacé ». */
  readonly partial: boolean;
}

export interface KnowledgeErasureDeps {
  readonly archive: MessageArchiveRepository;
  readonly facts?: KnowledgeFactRepository | null;
}

export class KnowledgeErasureService implements KnowledgeErasurePort {
  private readonly archive: MessageArchiveRepository;
  private readonly facts: KnowledgeFactRepository | null;

  constructor(deps: KnowledgeErasureDeps) {
    this.archive = deps.archive;
    this.facts = deps.facts ?? null;
  }

  async forget(scope: ForgetScope): Promise<KnowledgeErasureReport> {
    let facts = 0;
    let partial = false;

    if (this.facts) {
      try {
        facts = await this.facts.forgetUser(scope);
      } catch (error) {
        partial = true;
        logger.error("Faits distillés non effacés — l'archive n'est pas touchée non plus", {
          slackUserId: scope.slackUserId,
          channelId: scope.channelId,
          error: String(error),
        });
        /**
         * ⚠️ **ON S'ARRÊTE ICI, ET C'EST DÉLIBÉRÉ.** Poursuivre effacerait les messages en
         * laissant les faits : des résumés qui affirment sans plus rien pour les vérifier.
         * Mieux vaut n'avoir rien effacé et le DIRE que d'effacer à moitié en silence.
         */
        return { messages: 0, facts: 0, partial };
      }
    }

    let messages = 0;
    try {
      messages = await this.archive.forgetUser(scope);
    } catch (error) {
      partial = true;
      logger.error('Archive non effacée — les faits, eux, sont partis', {
        slackUserId: scope.slackUserId,
        channelId: scope.channelId,
        error: String(error),
      });
    }

    logger.info('Effacement de la base de connaissance', {
      slackUserId: scope.slackUserId,
      channelId: scope.channelId,
      messages,
      facts,
      partial,
    });

    return { messages, facts, partial };
  }
}
