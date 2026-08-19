/**
 * L'ENTRETIEN post-profil : ce que la personne dit d'elle une fois son dossier créé.
 *
 * ── Ce qu'il remplace ───────────────────────────────────────────────────────
 * La feature `questionnaire`. Relevé sur la Turso le 2026-08-14 : 5 questionnaires
 * enregistrés, **0 réponse** — il n'existait ni formulaire Block Kit, ni modale, ni route de
 * soumission, donc rien qu'un humain puisse remplir. Le tool le disait lui-même dans son
 * `hint`, ce qui prouve qu'on le savait sans le corriger.
 *
 * L'entretien inverse la construction : le formulaire existe D'ABORD (Block Kit, écrit en
 * code), et ce qui est stocké est ce qu'une personne a réellement répondu.
 *
 * ── Ce que les réponses servent ─────────────────────────────────────────────
 *  1. **Les canaux, immédiatement et déterministiquement.** La soumission invite réellement
 *     aux canaux cochés — aucun modèle sur ce chemin, la liste est fermée et vient de Slack.
 *  2. **Le guide de bienvenue**, qui cesse d'être générique : le gabarit imprime la matière
 *     réelle au lieu de puces écrites en dur.
 *
 * ⚠️ TypeScript pur — cette entité traverse la couche `domain`.
 */
export interface OnboardingInterview {
  readonly employeeId: string;
  readonly slackUserId: string;
  /** Identifiants `C…`, jamais les noms : un canal se renomme, son ID non. */
  readonly channels: readonly string[];
  /** Ce que la personne fait au quotidien. Chaîne vide = non renseigné, jamais `null`. */
  readonly dailyWork: string;
  /** Comment elle préfère travailler. Chaîne vide = non renseigné. */
  readonly workStyle: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OnboardingInterviewRepository {
  findByEmployee(employeeId: string): Promise<OnboardingInterview | null>;

  /**
   * Tous les entretiens.
   *
   * ⚠️ Ajouté le 2026-08-19 pour `findExpertise`, sur un défaut mesuré en production : à
   * « qui s'occupe du support technique ? », l'outil a répondu « aucun collaborateur n'est
   * identifié » alors que la personne venait d'écrire, dans son entretien, qu'elle fait du
   * support technique. La réponse était HONNÊTE — la donnée était ailleurs — mais l'entretien
   * est le seul endroit où quelqu'un décrit son métier avec ses mots, ce qui est exactement ce
   * qu'une recherche d'expertise cherche.
   *
   * Pas de pagination : la table a UNE ligne par employé, et `employees` en compte deux. Si
   * elle devait croître, c'est la borne de `findExpertise` (6 résultats) qui protège le
   * tool-result, pas celle-ci.
   */
  listAll(): Promise<OnboardingInterview[]>;

  /**
   * Écrit l'entretien, en ÉCRASANT le précédent s'il existe.
   *
   * `employee_id` est la clé primaire : un employé a un entretien, pas une collection. Une
   * seconde soumission est une CORRECTION, pas une nouvelle réponse — et laisser deux lignes
   * coexister obligerait chaque lecteur à choisir laquelle fait foi, ce que personne ne ferait
   * deux fois de la même façon.
   *
   * ⚠️ `createdAt` de l'appelant n'est retenu qu'à l'INSERT. Une correction ne doit pas
   * réécrire la date du premier entretien — même invariant que `first_seen_at` dans
   * `slack_directory`, et pour la même raison : c'est un fait, pas un champ de mise à jour.
   */
  save(interview: OnboardingInterview): Promise<void>;
}
