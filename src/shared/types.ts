export enum EmployeeStatus {
  Pending = 'pending',
  Active = 'active',
  Onboarding = 'onboarding',
  Suspended = 'suspended',
  Inactive = 'inactive',
  Terminated = 'terminated',
}

export enum EmployeeRole {
  Employee = 'employee',
  Manager = 'manager',
}

export function isManagerRole(raw: string | null | undefined): boolean {
  return raw === EmployeeRole.Manager;
}

export enum OnboardingStatus {
  NotStarted = 'not_started',
  InProgress = 'in_progress',
  Completed = 'completed',
  Blocked = 'blocked',
  Cancelled = 'cancelled',
}

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

export enum Position {
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

  Designer = 'Designer',
  SeniorDesigner = 'Senior Designer',
  UXResearcher = 'UX Researcher',

  ProductManager = 'Product Manager',
  TechnicalProductManager = 'Technical Product Manager',

  TeamLead = 'Team Lead',
  Manager = 'Manager',
  Director = 'Director',
  VP = 'VP',
  CTO = 'CTO',
  CEO = 'CEO',

  HRManager = 'HR Manager',
  Recruiter = 'Recruiter',
  OfficeManager = 'Office Manager',
}

export enum TaskStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Blocked = 'blocked',
  InReview = 'in_review',
  Completed = 'completed',
  Skipped = 'skipped',
  Cancelled = 'cancelled',
  Archived = 'archived',
}

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

export enum TaskPriority {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Urgent = 'urgent',
}

export enum QuestionnaireStatus {
  Draft = 'draft',
  Published = 'published',
  Closed = 'closed',
  Archived = 'archived',
}

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

export enum ResponseStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Submitted = 'submitted',
  InReview = 'in_review',
  Reviewed = 'reviewed',
  Rejected = 'rejected',
}

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

export enum DocumentStatus {
  Pending = 'pending',
  Generating = 'generating',
  Generated = 'generated',
  Sent = 'sent',
  Viewed = 'viewed',
  Signed = 'signed',
  Expired = 'expired',
  Failed = 'failed',
}

export enum NotificationChannel {
  Email = 'email',
  Slack = 'slack',
  Teams = 'teams',
  InApp = 'in_app',
  Push = 'push',
  Sms = 'sms',
  Webhook = 'webhook',
}

export enum NotificationStatus {
  Pending = 'pending',
  PendingApproval = 'pending_approval',
  Scheduled = 'scheduled',
  Sending = 'sending',
  Sent = 'sent',
  Delivered = 'delivered',
  Read = 'read',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum NotificationPriority {
  Low = 'low',
  Normal = 'normal',
  High = 'high',
  Urgent = 'urgent',
}

export enum RecipientType {
  Employee = 'employee',
  Hr = 'hr',
  Manager = 'manager',
  Admin = 'admin',
  Team = 'team',
  Department = 'department',
}

export interface Timestamps {
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface Question {
  id: string;
  type: QuestionType;
  label: string;
  description?: string;
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
  order?: number;
  condition?: QuestionCondition;
}

export interface QuestionCondition {
  questionId: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than';
  value: string | number | boolean;
}

export interface QuestionResponse {
  questionId: string;
  value?: string | string[] | number | boolean;
  skipped?: boolean;
  comment?: string;
}

export type EnumValues<T extends Record<string, string>> = T[keyof T];

export type EmployeeId = string & { readonly __brand: 'EmployeeId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type DocumentId = string & { readonly __brand: 'DocumentId' };
export type QuestionnaireId = string & { readonly __brand: 'QuestionnaireId' };
export type NotificationId = string & { readonly __brand: 'NotificationId' };

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTaskFinalStatus(status: TaskStatus): boolean {
  return [TaskStatus.Completed, TaskStatus.Cancelled, TaskStatus.Archived].includes(status);
}

export function isTaskActiveStatus(status: TaskStatus): boolean {
  return [
    TaskStatus.Pending,
    TaskStatus.InProgress,
    TaskStatus.Blocked,
    TaskStatus.InReview,
  ].includes(status);
}
