export interface PdfService {
  generate(employeeData: Record<string, unknown>, templateId: string): Promise<string>;
}
