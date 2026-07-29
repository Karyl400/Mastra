export enum EmployeeStatus {
  Pending = 'pending',
  Active = 'active',
  Completed = 'completed',
  Exited = 'exited',
}

export enum TaskStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Completed = 'completed',
  Skipped = 'skipped',
}

export enum TaskType {
  Document = 'document',
  Questionnaire = 'questionnaire',
  Meeting = 'meeting',
  Training = 'training',
  Other = 'other',
}

export enum QuestionnaireStatus {
  Draft = 'draft',
  Published = 'published',
  Archived = 'archived',
}

export enum ResponseStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Submitted = 'submitted',
  Reviewed = 'reviewed',
}

export enum DocumentType {
  Contract = 'contract',
  WelcomeLetter = 'welcome_letter',
  Guide = 'guide',
  Certificate = 'certificate',
  Other = 'other',
}

export enum DocumentFormat {
  Pdf = 'pdf',
  Docx = 'docx',
  Txt = 'txt',
}

export enum DocumentStatus {
  Pending = 'pending',
  Generated = 'generated',
  Sent = 'sent',
}

export enum NotificationChannel {
  Email = 'email',
  Slack = 'slack',
  InApp = 'in_app',
}

export enum NotificationStatus {
  Pending = 'pending',
  Scheduled = 'scheduled',
  Sent = 'sent',
  Failed = 'failed',
  Read = 'read',
}

export enum RecipientType {
  Employee = 'employee',
  Hr = 'hr',
  Manager = 'manager',
}

export enum OnboardingStatus {
  NotStarted = 'not_started',
  InProgress = 'in_progress',
  Completed = 'completed',
  Blocked = 'blocked',
}

export interface Timestamps {
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface Question {
  id: string;
  type: 'text' | 'choice' | 'multiple_choice' | 'scale' | 'boolean';
  label: string;
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
}
