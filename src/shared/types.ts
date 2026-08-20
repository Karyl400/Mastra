// ============================================
// shared/types/index.ts - Domain Types
// Standards 2026: Const Enums, JSDoc, Exhaustive States
// ============================================

// ============================================
// 1. ENUMS - EMPLOYEE
// ============================================

/** Statut d'emploi d'un collaborateur */
export enum EmployeeStatus {
  /** En attente de validation / intégration */
  Pending = 'pending',
  /** Actif dans l'entreprise */
  Active = 'active',
  /** En période d'essai / onboarding */
  Onboarding = 'onboarding',
  /** Suspendu temporairement (congé, maladie, etc.) */
  Suspended = 'suspended',
  /** Inactif (longue absence) */
  Inactive = 'inactive',
  /** A quitté l'entreprise */
  Terminated = 'terminated',
}

/**
 * RÔLE d'un collaborateur — la seule chose qui accorde une portée au-delà de soi-même.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi le rôle, et pas le poste
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `position` (« Backend Developer », « Manager ») est un champ DÉCLARATIF : la personne le
 * saisit elle-même dans l'échange de complétion de dossier, et `title` côté annuaire vient de
 * son profil Slack, qu'elle édite aussi. Faire dépendre une autorisation de l'un ou de l'autre
 * offrirait l'élévation de privilège la plus simple qui soit — taper « Manager » dans son
 * propre profil. Ce dépôt refuse déjà, pour la même raison, de décider d'un droit sur une
 * valeur produite par le modèle : on ne décide pas d'un droit sur une valeur que le
 * bénéficiaire écrit.
 *
 * Le rôle, lui, n'est écrit par AUCUN chemin en libre-service. Il se pose délibérément
 * (`npm run role:set`), et c'est cette asymétrie qui en fait un fait d'autorisation.
 *
 * ⚠️ Deux valeurs, pas davantage. `CONTEXT.md` annonçait un RBAC Employé / RH / Manager ;
 * inventer un palier « RH » dont aucun outil ne dépendrait produirait exactement le défaut que
 * ce dépôt combat — un composant enregistré qui promet plus qu'il ne tient. On ajoutera le
 * troisième le jour où un outil saura en faire quelque chose.
 */
export enum EmployeeRole {
  /** Voit et agit sur SON dossier. Le défaut, et il l'est pour tout le monde. */
  Employee = 'employee',
  /** Voit et agit sur le dossier de TOUT LE MONDE. */
  Manager = 'manager',
}

/**
 * Lecture TOLÉRANTE d'un rôle venu de la base.
 *
 * Toute valeur inconnue vaut `employee`, jamais `manager` : une colonne corrompue, une valeur
 * écrite par une version future, ou un `NULL` sur une ligne antérieure à la migration ne
 * doivent pas pouvoir ACCORDER quoi que ce soit. Le défaut sûr est celui qui ne donne rien —
 * même arbitrage que `readSlackContext`, où un niveau d'accès inconnu est ignoré plutôt
 * qu'interprété.
 */
export function isManagerRole(raw: string | null | undefined): boolean {
  return raw === EmployeeRole.Manager;
}

/** Statut du processus d'onboarding */
export enum OnboardingStatus {
  /** N'a pas encore commencé */
  NotStarted = 'not_started',
  /** En cours */
  InProgress = 'in_progress',
  /** Complété avec succès */
  Completed = 'completed',
  /** Bloqué (en attente d'une action externe) */
  Blocked = 'blocked',
  /** Abandonné / annulé */
  Cancelled = 'cancelled',
}

/** Départements de l'entreprise */
export enum Department {
  Engineering = 'Engineering',
  Product = 'Product',
  Design = 'Design',
  HR = 'HR',
  Sales = 'Sales',
  Marketing = 'Marketing',
  Finance = 'Finance',
  Legal = 'Legal',
  Operations = 'Operations',
  CustomerSuccess = 'CustomerSuccess',
  IT = 'IT',
  Executive = 'Executive',
}

/** Postes / Rôles */
export enum Position {
  // Engineering
  BackendDeveloper = 'Backend Developer',
  FrontendDeveloper = 'Frontend Developer',
  FullStackDeveloper = 'Full Stack Developer',
  SeniorDeveloper = 'Senior Developer',
  Developer = 'Developer',
  StaffEngineer = 'Staff Engineer',
  EngineeringManager = 'Engineering Manager',
  DevOpsEngineer = 'DevOps Engineer',
  QAEngineer = 'QA Engineer',
  DataEngineer = 'Data Engineer',

  // Design
  Designer = 'Designer',
  SeniorDesigner = 'Senior Designer',
  UXResearcher = 'UX Researcher',

  // Product
  ProductManager = 'Product Manager',
  TechnicalProductManager = 'Technical Product Manager',

  // Management
  TeamLead = 'Team Lead',
  Manager = 'Manager',
  Director = 'Director',
  VP = 'VP',
  CTO = 'CTO',
  CEO = 'CEO',

  // Support
  HRManager = 'HR Manager',
  Recruiter = 'Recruiter',
  OfficeManager = 'Office Manager',
}

// ============================================
// 2. ENUMS - TASKS
// ============================================

/** Statut d'une tâche (workflow complet) */
export enum TaskStatus {
  /** En attente d'être commencée */
  Pending = 'pending',
  /** En cours de réalisation */
  InProgress = 'in_progress',
  /** Bloquée par une dépendance */
  Blocked = 'blocked',
  /** En attente de revue */
  InReview = 'in_review',
  /** Complétée */
  Completed = 'completed',
  /** Sautée (non applicable) */
  Skipped = 'skipped',
  /** Annulée */
  Cancelled = 'cancelled',
  /** Archivée (visible uniquement en historique) */
  Archived = 'archived',
}

/** Transitions valides entre statuts de tâche */
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.Pending]: [TaskStatus.InProgress, TaskStatus.Skipped, TaskStatus.Cancelled],
  [TaskStatus.InProgress]: [
    TaskStatus.Blocked,
    TaskStatus.InReview,
    TaskStatus.Completed,
    TaskStatus.Cancelled,
  ],
  [TaskStatus.Blocked]: [TaskStatus.InProgress, TaskStatus.Cancelled],
  [TaskStatus.InReview]: [TaskStatus.InProgress, TaskStatus.Completed, TaskStatus.Cancelled],
  [TaskStatus.Completed]: [TaskStatus.Archived],
  [TaskStatus.Skipped]: [TaskStatus.Archived, TaskStatus.Pending],
  [TaskStatus.Cancelled]: [TaskStatus.Archived],
  [TaskStatus.Archived]: [],
};

/** Type de tâche */
export enum TaskType {
  Document = 'document',
  Questionnaire = 'questionnaire',
  Meeting = 'meeting',
  Training = 'training',
  Review = 'review',
  Approval = 'approval',
  Individual = 'individual',
  Team = 'team',
  Onboarding = 'onboarding',
  Custom = 'custom',
  Other = 'other',
}

/** Priorité d'une tâche */
export enum TaskPriority {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Urgent = 'urgent',
}

// ============================================
// 3. ENUMS - QUESTIONNAIRES
// ============================================

/** Statut d'un questionnaire */
export enum QuestionnaireStatus {
  /** Brouillon non publié */
  Draft = 'draft',
  /** Publié et disponible */
  Published = 'published',
  /** Clôturé (n'accepte plus de réponses) */
  Closed = 'closed',
  /** Archivé */
  Archived = 'archived',
}

/** Type de question */
export enum QuestionType {
  Text = 'text',
  Paragraph = 'paragraph',
  Choice = 'choice',
  MultipleChoice = 'multiple_choice',
  Scale = 'scale',
  Boolean = 'boolean',
  Date = 'date',
  FileUpload = 'file_upload',
  Rating = 'rating',
  Matrix = 'matrix',
}

/** Statut d'une réponse individuelle */
export enum ResponseStatus {
  /** En attente de réponse */
  Pending = 'pending',
  /** Réponse en cours (partiellement remplie) */
  InProgress = 'in_progress',
  /** Soumise */
  Submitted = 'submitted',
  /** En cours de revue par un manager */
  InReview = 'in_review',
  /** Revue terminée */
  Reviewed = 'reviewed',
  /** Rejetée / à refaire */
  Rejected = 'rejected',
}

// ============================================
// 4. ENUMS - DOCUMENTS
// ============================================

/** Type de document */
export enum DocumentType {
  Contract = 'contract',
  Amendment = 'amendment',
  WelcomeLetter = 'welcome_letter',
  Guide = 'guide',
  Certificate = 'certificate',
  Policy = 'policy',
  TaxForm = 'tax_form',
  IDDocument = 'id_document',
  Other = 'other',
}

/** Format de document */
export enum DocumentFormat {
  Pdf = 'pdf',
  Docx = 'docx',
  Txt = 'txt',
  Markdown = 'markdown',
  Html = 'html',
  Json = 'json',
  Csv = 'csv',
  Xlsx = 'xlsx',
  Pptx = 'pptx',
  Image = 'image',
}

/** Statut d'un document */
export enum DocumentStatus {
  /** En attente de génération */
  Pending = 'pending',
  /** En cours de génération */
  Generating = 'generating',
  /** Généré */
  Generated = 'generated',
  /** Envoyé au destinataire */
  Sent = 'sent',
  /** Consulté par le destinataire */
  Viewed = 'viewed',
  /** Signé électroniquement */
  Signed = 'signed',
  /** Expiré */
  Expired = 'expired',
  /** Échec de génération */
  Failed = 'failed',
}

// ============================================
// 5. ENUMS - NOTIFICATIONS
// ============================================

/** Canal de notification */
export enum NotificationChannel {
  Email = 'email',
  Slack = 'slack',
  Teams = 'teams',
  InApp = 'in_app',
  Push = 'push',
  Sms = 'sms',
  Webhook = 'webhook',
}

/** Statut d'une notification */
export enum NotificationStatus {
  /** En attente d'envoi */
  Pending = 'pending',
  /** En attente d'approbation (pour les notifications sensibles) */
  PendingApproval = 'pending_approval',
  /** Planifiée pour un envoi futur */
  Scheduled = 'scheduled',
  /** En cours d'envoi */
  Sending = 'sending',
  /** Envoyée avec succès */
  Sent = 'sent',
  /** Remise au destinataire confirmée */
  Delivered = 'delivered',
  /** Lue par le destinataire */
  Read = 'read',
  /** Échec d'envoi */
  Failed = 'failed',
  /** Annulée avant envoi */
  Cancelled = 'cancelled',
}

/** Priorité d'une notification */
export enum NotificationPriority {
  Low = 'low',
  Normal = 'normal',
  High = 'high',
  Urgent = 'urgent',
}

/** Type de destinataire */
export enum RecipientType {
  Employee = 'employee',
  Hr = 'hr',
  Manager = 'manager',
  Admin = 'admin',
  Team = 'team',
  Department = 'department',
}

// ============================================
// 6. INTERFACES - DOMAINE
// ============================================

/** Timestamps communs à toutes les entités */
export interface Timestamps {
  /** Date de création */
  createdAt: string;
  /** Date de dernière modification */
  updatedAt: string;
  /** Date de suppression (soft delete) */
  deletedAt?: string | null;
}

/** Question dans un questionnaire */
export interface Question {
  /** Identifiant unique */
  id: string;
  /** Type de question */
  type: QuestionType;
  /** Libellé de la question */
  label: string;
  /** Description / aide contextuelle */
  description?: string;
  /** La réponse est-elle obligatoire ? */
  required: boolean;
  /** Options (pour choice, multiple_choice) */
  options?: string[];
  /** Valeur minimale (pour scale, rating) */
  min?: number;
  /** Valeur maximale (pour scale, rating) */
  max?: number;
  /** Étiquette min (ex: "Pas du tout d'accord") */
  minLabel?: string;
  /** Étiquette max (ex: "Tout à fait d'accord") */
  maxLabel?: string;
  /** Ordre d'affichage dans le questionnaire */
  order?: number;
  /** Condition d'affichage (dépend d'une autre question) */
  condition?: QuestionCondition;
}

/** Condition d'affichage d'une question */
export interface QuestionCondition {
  /** ID de la question dont dépend celle-ci */
  questionId: string;
  /** Opérateur de comparaison */
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than';
  /** Valeur à comparer */
  value: string | number | boolean;
}

/** Réponse à une question */
export interface QuestionResponse {
  /** ID de la question */
  questionId: string;
  /** Valeur de la réponse (type dépend du type de question) */
  value?: string | string[] | number | boolean;
  /** La question a-t-elle été sautée ? */
  skipped?: boolean;
  /** Commentaire additionnel */
  comment?: string;
}

// ⚠️ DOUZE EXPORTS SUPPRIMÉS LE 2026-08-18 — aucun n'avait le moindre appelant, ni dans
// `src/`, ni dans `tests/`, ni dans `scripts/`, et le compilateur le prouve.
//
// Trois sacs de ré-export (`Enums`, `Constants`, `Validators`) qui regroupaient des symboles
// que tout le monde importe individuellement ; les statuts et types de question de deux
// features SUPPRIMÉES du dépôt le 2026-08-14 ; et la pagination d'une API qui n'existe pas
// (`PaginationMeta`, `PaginatedResponse`).
//
// Ce n'est pas du ménage pour le plaisir : un fichier de types qui expose un vocabulaire
// mort le fait paraître disponible, et le prochain à écrire une fonctionnalité de pagination
// croira qu'il y a une convention à suivre. Les enums individuels et les prédicats de
// transition, eux, servent — ils ne bougent pas.

// ============================================
// 7. TYPES UTILITAIRES
// ============================================

/** Extrait les clés d'une enum string */
export type EnumValues<T extends Record<string, string>> = T[keyof T];

/** Type pour les identifiants (branded type pour éviter la confusion) */
export type EmployeeId = string & { readonly __brand: 'EmployeeId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type DocumentId = string & { readonly __brand: 'DocumentId' };
export type QuestionnaireId = string & { readonly __brand: 'QuestionnaireId' };
export type NotificationId = string & { readonly __brand: 'NotificationId' };

// ============================================
// 8. VALIDATEURS DE TRANSITIONS
// ============================================

/** Vérifie si une transition de statut de tâche est valide */
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Vérifie si un statut de tâche est un état final */
export function isTaskFinalStatus(status: TaskStatus): boolean {
  return [TaskStatus.Completed, TaskStatus.Cancelled, TaskStatus.Archived].includes(status);
}

/** Vérifie si un statut de tâche est un état actif */
export function isTaskActiveStatus(status: TaskStatus): boolean {
  return [
    TaskStatus.Pending,
    TaskStatus.InProgress,
    TaskStatus.Blocked,
    TaskStatus.InReview,
  ].includes(status);
}

// ============================================
// 9. CONSTANTES
// ============================================

// ============================================
// 10. EXPORTS
// ============================================

// Tous les enums et interfaces sont déjà exportés individuellement ci-dessus.
// Export groupé pour faciliter l'import :
