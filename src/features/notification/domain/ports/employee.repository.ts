export interface EmployeeDirectoryRecord {
  readonly id: string;
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly managerId?: string | null;
}

export interface EmployeeRepository {
  findById(id: string): Promise<EmployeeDirectoryRecord | null>;
}
