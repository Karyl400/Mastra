import { describe, expect, it, vi } from 'vitest';

import {
  CURTAIN_BATCH_SIZE,
  CURTAIN_WINDOW_MS,
  runFactCurtain,
} from '../../../src/features/knowledge/application/services/fact-curtain.service';
import { KnowledgeIngestionService } from '../../../src/features/knowledge/application/services/knowledge-ingestion.service';
import { InMemoryMessageArchiveRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-message-archive.repository';
import { InMemoryKnowledgeFactRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-knowledge-fact.repository';
import { KNOWLEDGE_FACT_MIN_SCORE } from '../../../src/features/knowledge/domain/services/fact-distillation';
/**
 * ⚠️ **IMPORT STATIQUE, et il l'est depuis le 2026-08-21 pour une raison mesurée.**
 *
 * Il était DYNAMIQUE, dans le corps du premier `it`. Le test échouait alors par
 * `Timeout 5000ms` — mesuré à **5 009 ms**, c'est-à-dire exactement sur la ligne. Ce n'était ni
 * un appel réseau (l'agent est injecté) ni le coût d'import brut, mais la TRANSFORMATION Vite :
 * `server.deps.inline: [/@mastra\/core/]` fait passer tout `@mastra/core` par le pipeline, et
 * `llm-guardrail` y ajoute un `scryptSync(N=16384)` au chargement du module — 49 ms mesurés.
 * Ce coût était imputé au délai du test.
 *
 * Le fichier passait dans la suite complète et échouait SEUL, parce que `singleFork: true`
 * partage le cache de modules : **le test ne passait que grâce au travail d'un autre fichier.**
 * Or c'est le fichier qu'on lance seul quand on débogue — et il rendait alors un
 * `Timeout 5000ms` qui ne désigne pas sa cause, la classe de panne que ce dépôt traque partout.
 *
 * Poser un `testTimeout` aurait masqué la cause au lieu de la retirer.
 */
import { ModelFactSummarizer } from '../../../src/features/knowledge/infrastructure/services/model-fact-summarizer.service';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE SECOND RIDEAU — code d'abord, modèle en rattrapage
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `distillFact` attrape ce qui RESSEMBLE à une décision. Il ne peut pas attraper ce qui n'y
 * ressemble pas : « finalement on garde l'ancien fournisseur, ça ira jusqu'en mars » ne contient
 * aucun de ses motifs, et EST une décision.
 *
 * Ce rideau existe pour ce reste-là, et pour lui seul. Sur le chemin nominal — le code classe —
 * il ne coûte pas un seul appel de modèle.
 */

function msg(id: string, text: string, postedAt = Date.now() - 60_000) {
  return { id, channelId: 'C1', slackUserId: 'U1', text, threadTs: null, postedAt };
}

async function seed(archive: InMemoryMessageArchiveRepository, n: number, text = 'bonjour a tous') {
  for (let i = 0; i < n; i += 1) {
    await archive.archive(msg(`C1:${i}`, `${text} ${i}`, Date.now() - 60_000 + i));
  }
}

describe('le rideau ne se lève qu’à cinq', () => {
  it('ne fait RIEN tant que le lot n’est pas complet', async () => {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const summarize = vi.fn();
    await seed(archive, CURTAIN_BATCH_SIZE - 1);

    const report = await runFactCurtain({ archive, facts, summarizer: { summarize } });

    expect(report.examined).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('appelle le modèle UNE fois pour cinq messages', async () => {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const summarize = vi.fn().mockResolvedValue([]);
    await seed(archive, CURTAIN_BATCH_SIZE);

    await runFactCurtain({ archive, facts, summarizer: { summarize } });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0]).toHaveLength(CURTAIN_BATCH_SIZE);
  });

  /**
   * ⚠️ **LE CONTRÔLE LE PLUS IMPORTANT DU FICHIER.** Sans la marque, cinq messages sans intérêt
   * seraient relus à chaque nouveau message : un appel de modèle PAR MESSAGE, c'est-à-dire
   * l'inverse exact de ce que le lot de cinq existe pour éviter.
   */
  it('marque TOUT le lot, y compris ce dont le modèle n’a rien tiré', async () => {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const summarize = vi.fn().mockResolvedValue([]);
    await seed(archive, CURTAIN_BATCH_SIZE);

    await runFactCurtain({ archive, facts, summarizer: { summarize } });
    await runFactCurtain({ archive, facts, summarizer: { summarize } });

    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('marque le lot MÊME si le modèle échoue — jamais une boucle de réessai', async () => {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const summarize = vi.fn().mockRejectedValue(new Error('gemini down'));
    await seed(archive, CURTAIN_BATCH_SIZE);

    const report = await runFactCurtain({ archive, facts, summarizer: { summarize } });

    expect(report).toMatchObject({ examined: CURTAIN_BATCH_SIZE, recorded: 0 });
    expect(await archive.pendingDistillation(CURTAIN_WINDOW_MS, 10)).toHaveLength(0);
  });

  it('ne regarde JAMAIS hors de sa fenêtre — allumer un rideau ne réveille pas l’histoire', async () => {
    // Leçon payée le même jour sur les rappels : la première exécution du cron a remis des
    // lignes écrites des semaines plus tôt. Sans fenêtre, l'archive entière partirait au
    // modèle, par lots de cinq, jusqu'à épuisement.
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const summarize = vi.fn().mockResolvedValue([]);
    const old = Date.now() - CURTAIN_WINDOW_MS - 60_000;
    for (let i = 0; i < CURTAIN_BATCH_SIZE; i += 1) {
      await archive.archive(msg(`C1:vieux${i}`, `vieux message ${i}`, old + i));
    }

    const report = await runFactCurtain({ archive, facts, summarizer: { summarize } });

    expect(report.examined).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe('ce que le modèle rend est de la DONNÉE, pas de la parole de confiance', () => {
  async function run(summarized: unknown[]) {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    await seed(archive, CURTAIN_BATCH_SIZE);
    const report = await runFactCurtain({
      archive,
      facts,
      summarizer: { summarize: async () => summarized as never },
    });
    return { report, facts };
  }

  it('enregistre un fait bien formé', async () => {
    const { report, facts } = await run([
      { index: 1, kind: 'decision', summary: 'on garde l’ancien fournisseur jusqu’en mars' },
    ]);

    expect(report.recorded).toBe(1);
    const found = await facts.search('fournisseur');
    expect(found[0]?.summary).toContain('fournisseur');
  });

  /**
   * ⚠️ **LE MODÈLE DÉSIGNE PAR UN RANG, PAS PAR UN IDENTIFIANT — et c'est une correction née
   * d'une mesure en production le 2026-08-21.**
   *
   * La première version lui faisait recopier l'identifiant d'archive
   * (`CMLKC4S5T:1787323636.317000`). Résultat mesuré : `examined:5, recorded:0, rejected:5`.
   * Le modèle avait répondu ; aucune de ses lignes n'a pu être rattachée. Un identifiant long,
   * ponctué, à décimales, est un identifiant qu'un modèle normalise sans le vouloir — et
   * l'échec est SILENCIEUX, puisque le rejet est le comportement sûr.
   *
   * Pendant d'une règle déjà écrite pour `generateDocument.revises` : un identifiant qu'on
   * demande au modèle est un identifiant qu'il peut inventer. On ajoute qu'il peut aussi le
   * recopier de travers.
   */
  it('JETTE un rang hors du lot', async () => {
    const { report } = await run([{ index: 99, kind: 'decision', summary: 'quelque chose' }]);

    expect(report).toMatchObject({ recorded: 0, rejected: 1 });
  });

  it('JETTE un rang absurde — zéro, négatif', async () => {
    const { report } = await run([
      { index: 0, kind: 'decision', summary: 'x' },
      { index: -1, kind: 'decision', summary: 'y' },
    ]);

    expect(report).toMatchObject({ recorded: 0, rejected: 2 });
  });

  it('JETTE un `kind` hors énumération plutôt que de le corriger', async () => {
    const { report } = await run([{ index: 1, kind: 'potin', summary: 'quelque chose' }]);

    expect(report).toMatchObject({ recorded: 0, rejected: 1 });
  });

  it('ASSAINIT la sortie : un marqueur interne recopié ne doit pas entrer en base', async () => {
    // Une ligne stockée avec un marqueur ressortirait telle quelle à la première recherche —
    // le contournement exact du filtre unique corrigé sur les documents le 2026-08-11.
    const { facts } = await run([
      { index: 1, kind: 'decision', summary: 'décision [SECURITY_BLOCK] KISSO-AGENT-v3 prise' },
    ]);

    const all = await facts.recent({ limit: 10 });
    expect(JSON.stringify(all)).not.toContain('KISSO-AGENT-v3');
    expect(JSON.stringify(all)).not.toContain('[SECURITY_BLOCK]');
  });

  it('le score du rideau est le PLANCHER — il ne passe pas devant le code', async () => {
    const { facts } = await run([
      { index: 1, kind: 'decision', summary: 'on garde l’ancien fournisseur' },
    ]);

    const all = await facts.recent({ limit: 10 });
    expect(all[0]?.score).toBe(KNOWLEDGE_FACT_MIN_SCORE);
  });
});

describe('l’ingestion ne lève le rideau que sur ce que le code n’a pas classé', () => {
  it('un message CLASSÉ par le code ne déclenche aucun appel de modèle', async () => {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const summarize = vi.fn().mockResolvedValue([]);
    const ingestion = new KnowledgeIngestionService({
      archive,
      facts,
      summarizer: { summarize },
    });

    await ingestion.ingest(
      msg('C1:a', 'on a decide de partir sur postgres pour le reporting mensuel'),
    );

    expect(summarize).not.toHaveBeenCalled();
  });

  it('sans distillateur de second rideau, le comportement est celui d’avant — aucun modèle', async () => {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const ingestion = new KnowledgeIngestionService({ archive, facts });

    await ingestion.ingest(msg('C1:a', 'bonjour tout le monde'));

    expect(archive.size).toBe(1);
  });

  it('l’archivage survit à un rideau en panne — c’est la seule perte irréversible', async () => {
    const archive = new InMemoryMessageArchiveRepository();
    const facts = new InMemoryKnowledgeFactRepository();
    const ingestion = new KnowledgeIngestionService({
      archive,
      facts,
      summarizer: {
        summarize: async () => {
          throw new Error('boom');
        },
      },
    });

    await seed(archive, CURTAIN_BATCH_SIZE);
    await expect(ingestion.ingest(msg('C1:z', 'coucou'))).resolves.toBeUndefined();
    expect(archive.size).toBe(CURTAIN_BATCH_SIZE + 1);
  });
});

/**
 * La LECTURE de ce que le modèle rend : tolérante sur la forme, stricte sur le fond.
 * Rejeter une réponse juste pour un tiret en trop, c'est le défaut qu'on vient de payer.
 */
describe('la lecture des lignes rendues par le modèle', () => {
  async function parse(text: string) {
    const summarizer = new ModelFactSummarizer({
      agent: { generate: async () => ({ text }) } as never,
    });
    return summarizer.summarize([{ id: 'a', text: 'x' }]);
  }

  it('lit la forme demandée', async () => {
    expect(await parse('1|decision|on garde l’ancien fournisseur')).toEqual([
      { index: 1, kind: 'decision', summary: 'on garde l’ancien fournisseur' },
    ]);
  });

  it('tolère une puce, un point, des espaces — ce que tout modèle ajoute', async () => {
    const lines = await parse('- 2. | Decision | on garde l’ancien fournisseur');
    expect(lines).toEqual([
      { index: 2, kind: 'decision', summary: 'on garde l’ancien fournisseur' },
    ]);
  });

  it('ignore une ligne de préambule au lieu de tout jeter', async () => {
    const lines = await parse('Voici les éléments retenus :\n1|blocage|la migration est repoussée');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('blocage');
  });

  it('rend une liste VIDE quand le modèle ne rend rien — pas une erreur', async () => {
    expect(await parse('')).toEqual([]);
    expect(await parse('Rien à signaler.')).toEqual([]);
  });

  it('garde le résumé entier même s’il contient une barre verticale', async () => {
    const lines = await parse('1|decision|on garde A | B jusqu’en mars');
    expect(lines[0]?.summary).toBe('on garde A | B jusqu’en mars');
  });
});
