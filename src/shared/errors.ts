export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404);
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class ConflictError extends AppError {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message, 'CONFLICT', 409);
  }
}

export class NotificationError extends AppError {
  constructor(channel: string, reason: string) {
    super(`Notification failed on ${channel}: ${reason}`, 'NOTIFICATION_ERROR', 500);
  }
}

export class DomainError extends AppError {
  constructor(message: string, code: string = 'DOMAIN_ERROR') {
    super(message, code, 400);
  }
}

export class DatabaseError extends AppError {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message, 'DATABASE_ERROR', 500);
  }
}

export class SecurityBlockError extends AppError {
  constructor(message: string) {
    super(message, 'SECURITY_BLOCK', 403);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 'SERVICE_UNAVAILABLE', 503);
  }
}

export class InjectionAttemptError extends AppError {
  constructor(message: string) {
    super(message, 'INJECTION_ATTEMPT', 400);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
