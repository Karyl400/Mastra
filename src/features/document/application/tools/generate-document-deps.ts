import type { DocumentRepository } from '../../domain/ports/document.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { DocumentRenderer } from '../../domain/ports/document-renderer';
import type {
  EmailProvider,
  FileUploadProvider,
} from '../../../notification/domain/ports/providers';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';

export interface GenerateDocumentDeps {
  documentRepo: DocumentRepository;
  employeeRepo: EmployeeRepository;
  renderers: readonly DocumentRenderer[];
  fileUpload?: FileUploadProvider;
  emailProvider?: EmailProvider;
  interviewRepo?: OnboardingInterviewRepository;
  channelRepo?: { listChannels(): Promise<ReadonlyArray<{ channelId: string; name: string }>> };
}
