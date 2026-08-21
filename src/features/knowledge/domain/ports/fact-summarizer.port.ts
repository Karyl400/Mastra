import type { FactKind } from '../services/fact-distillation';

export interface SummarizableMessage {
  readonly id: string;
  readonly text: string;
}

export interface SummarizedFact {
  /**
   * ⚠️ **LE RANG DANS LE LOT (1..n), PAS L'IDENTIFIANT DU MESSAGE.**
   *
   * La première version faisait recopier au modèle l'identifiant d'archive
   * (`CMLKC4S5T:1787323636.317000`). Mesuré en production le 2026-08-21 :
   * `{"examined":5,"recorded":0,"rejected":5}` — le modèle a bien répondu, et AUCUNE de ses
   * cinq lignes n'a pu être rattachée. Un identifiant long, ponctué, à décimales, est un
   * identifiant qu'un modèle normalise sans le vouloir.
   *
   * C'est le pendant d'une règle déjà écrite ici pour `generateDocument.revises` : un
   * identifiant qu'on demande au modèle est un identifiant qu'il peut inventer. On ajoute
   * qu'il peut aussi, simplement, le recopier de travers — et l'échec est alors SILENCIEUX,
   * puisque le rejet est le comportement sûr.
   *
   * Un rang est court, sans ponctuation, et un rang faux reste rejeté sans risque.
   */
  readonly index: number;
  readonly kind: FactKind;
  readonly summary: string;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE SECOND RIDEAU — ce que le code n'a pas su classer
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `distillFact` est du CODE : gratuit, rejouable, testable, et il attrape ce qui ressemble à
 * une décision, un engagement, un blocage, une échéance. Il ne peut pas attraper ce qui n'y
 * ressemble pas — « finalement on garde l'ancien fournisseur, ça ira jusqu'en mars » ne
 * contient aucun de ses motifs et EST une décision.
 *
 * Ce port existe pour ce reste-là, et pour lui seul.
 *
 * ⚠️ **IL NE VOIT QUE CE QUE LE CODE A LAISSÉ PASSER.** Le rideau déterministe reste devant :
 * le modèle n'est ni un remplacement ni une relecture, c'est un rattrapage. Sur un workspace
 * où le code attrape l'essentiel, ce port ne coûte presque rien ; s'il coûtait beaucoup, ce
 * serait le signe qu'il faut élargir les motifs, pas augmenter le budget.
 *
 * ⚠️ **LE TEXTE QU'IL REÇOIT EST HOSTILE PAR HYPOTHÈSE.** Ce sont des messages Slack : la
 * surface d'injection la plus directe du produit. Trois conséquences, toutes dans
 * l'implémentation et non dans une consigne :
 *   1. l'entrée est encadrée par la bannière de données non fiables ;
 *   2. la sortie est ASSAINIE avant d'être stockée — un marqueur interne recopié par le modèle
 *      dans un `summary` ressortirait tel quel à la première recherche ;
 *   3. le `kind` est contraint à l'énumération : ce que le modèle rend hors liste est jeté,
 *      jamais « corrigé ».
 *
 * ⚠️ **IL NE LÈVE JAMAIS.** Une panne de modèle ne doit pas empêcher l'archivage : le niveau 1
 * garde le message, et la recherche dégrade vers les messages bruts. C'est déjà le contrat de
 * `KnowledgeIngestionService.distil`.
 */
export interface FactSummarizerPort {
  summarize(messages: readonly SummarizableMessage[]): Promise<readonly SummarizedFact[]>;
}
