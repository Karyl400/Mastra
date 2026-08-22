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
