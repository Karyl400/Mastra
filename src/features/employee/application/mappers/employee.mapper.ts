import { Employee } from '../../domain/entities/employee';
import { EmployeeDto } from '../dtos/employee.dto';

export class EmployeeMapper {
  static toDomain(dto: EmployeeDto): Partial<Employee> {
    return {
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      department: dto.department,
      position: dto.position,
      startDate: dto.startDate,
    };
  }

  static toDto(entity: Employee): EmployeeDto {
    return {
      id: entity.id,
      firstName: entity.firstName,
      lastName: entity.lastName,
      email: entity.email,
      department: entity.department,
      position: entity.position,
      startDate: entity.startDate,
      status: entity.status,
    };
  }
}
