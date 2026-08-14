import type { DocumentFormat, DocumentType } from '../../../../shared/types';

/**
 * Rendu binaire d'un document.
 *
 * `Uint8Array` et non `Buffer` : `Buffer` est un type Node, et la couche `domain`
 * doit rester du TypeScript pur (garde-fou `tests/unit/quality/architecture.test.ts`).
 * Les implémentations rendent en pratique un `Buffer`, qui EST un `Uint8Array` —
 * la contrainte ne coûte donc rien au runtime et garde le port transportable.
 */
export interface RenderedDocument {
  bytes: Uint8Array;
  /** Nom sûr, déjà assaini : il part chez Slack et en pièce jointe email. */
  filename: string;
  mimeType: string;
}

export interface DocumentRenderInput {
  type: DocumentType;
  title: string;
  /** Corps libre rédigé par l'agent — potentiellement multi-paragraphes. */
  content: string;
  employee?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    department?: string;
    position?: string;
    startDate?: string;
  };
  /**
   * Ce que la personne a dit d'elle à l'entretien post-profil.
   *
   * ⚠️ Résolu CÔTÉ SERVEUR par `generateDocument`, exactement comme `employee` — jamais par
   * le modèle. C'est ce qui rend un guide personnel SANS coûter un token : le gabarit imprime
   * de la matière réelle, là où il imprimait auparavant quatre puces écrites en dur
   * (« Configuration poste de travail », « Accès Slack/GitHub »…) identiques pour tout le
   * monde. C'est le « document générique » signalé par le propriétaire.
   *
   * Chaque champ est OPTIONNEL et n'est rendu que s'il existe : un intertitre suivi du vide
   * se lit comme un oubli, pas comme une absence de réponse. Les trois champs de l'entretien
   * sont eux-mêmes facultatifs.
   */
  interview?: {
    /** Ce que la personne fait au quotidien, texte assaini à la saisie. */
    dailyWork?: string;
    /** Comment elle préfère travailler, texte assaini à la saisie. */
    workStyle?: string;
    /** NOMS des canaux qu'elle a choisis — pas les `C…`, qui ne se lisent pas. */
    channels?: readonly string[];
  };
}

/**
 * Un renderer par format. Le choix du format se fait en sélectionnant
 * l'implémentation, jamais en passant un drapeau : ainsi le contenu produit est
 * gouverné par un seul et même modèle logique (voir `domain/services/document-template.ts`).
 */
export interface DocumentRenderer {
  readonly format: DocumentFormat;
  render(input: DocumentRenderInput): Promise<RenderedDocument>;
}
