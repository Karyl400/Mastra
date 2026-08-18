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

/**
 * Le message lisible d'une erreur, quelle que soit sa forme.
 *
 * ⚠️ Existait en QUATRE exemplaires — `channel-coverage.service.ts` et
 * `welcome-channels.service.ts` (`messageOf`), `directory-sync.service.ts` (`describe`) et
 * `generate-document.ts` (`errorMessage`) — et la quatrième avait DÉJÀ divergé : elle rendait
 * `'Erreur inconnue'` là où les trois autres rendent `String(error)`.
 *
 * Cette divergence n'est pas cosmétique dans un dépôt qui journalise pour diagnostiquer :
 * `String(error)` conserve ce qu'un `throw 'texte'` ou un rejet d'objet portait, quand
 * « Erreur inconnue » le jette. On garde donc la forme la plus INFORMATIVE — sur un chemin
 * d'erreur, perdre l'information est le seul défaut qui compte.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
