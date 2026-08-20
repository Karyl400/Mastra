export interface EmployeeRepository {
  findById(id: string): Promise<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    position: string;
    startDate: string;
  } | null>;
}
