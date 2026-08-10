// create-employee.tool.ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { trace, metrics, SpanStatusCode, context, propagation } from '@opentelemetry/api';
import { withRetry } from '../../../../shared/retry';
import { Mutex } from 'async-mutex';
import { sanitizeHtml } from '../../../../shared/security/html-sanitizer.js';
import { createHash } from 'crypto';

import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { Employee } from '../../domain/entities/employee';
import { createEmployee } from '../../domain/entities/employee';
import { EmployeeStatus } from '../../../../shared/types';
import {
  uuidSchema,
  emailSchema,
  makeNameSchema,
  departmentSchema,
  positionSchema,
  startDateSchema,
} from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import {
  ConflictError,
  ValidationError,
  DatabaseError,
  DomainError,
  AppError,
} from '../../../../shared/errors';
import { EmployeeDto, employeeDtoSchema } from '../dtos/employee.dto';
import { EmployeeMapper } from '../mappers/employee.mapper';

// ============================================
// 1. TYPES ET INTERFACES STRICTS
// ============================================

/**
 * Contexte enrichi pour le tool
 */
interface CreateEmployeeContext {
  requestId: string;
  userId?: string;
  tenantId?: string;
  correlationId: string;
  spanContext?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Options de configuration du use case
 */
interface CreateEmployeeOptions {
  /** Génère un ID déterministe pour l'idempotence */
  idempotencyKey?: string;
  /** Évite la vérification d'unicité (pour les migrations) */
  skipUniquenessCheck?: boolean;
  /** Force un statut particulier */
  initialStatus?: EmployeeStatus;
  /** Métadonnées additionnelles */
  metadata?: Record<string, unknown>;
}

/**
 * Résultat de l'opération
 */
interface CreateEmployeeResult {
  employee: EmployeeDto;
  idempotent: boolean;
  warnings?: string[];
}

/**
 * Input validé et transformé
 */
interface ValidatedEmployeeInput {
  firstName: string;
  lastName: string;
  email: string;
  department: string;
  position: string;
  startDate: string;
  managerId: string | null;
  idempotencyKey?: string;
  initialStatus: EmployeeStatus;
}

// ============================================
// 2. SCHEMA DE VALIDATION ENRICHI
// ============================================

/**
 * Schema d'entrée avec validations métier
 */
const createEmployeeInputSchema = z.object({
  // makeNameSchema() et non nameSchema : deux occurrences de la MÊME instance Zod
  // sont dédupliquées en `{"$ref": "1/firstName"}` par zodToJsonSchema (voir validation.ts).
  firstName: makeNameSchema().describe("Prénom de l'employé"),
  lastName: makeNameSchema().describe("Nom de l'employé"),
  email: emailSchema.describe('Email professionnel'),
  department: departmentSchema.describe('Département'),
  position: positionSchema.describe('Poste'),
  startDate: startDateSchema.describe('Date de début (ISO 8601)'),

  // ⚠️ Schéma PLAT obligatoire (cf. src/shared/validation.ts) :
  // `uuidSchema.nullable().optional()` sérialise en
  // `anyOf: [{type:'string',format:'uuid'}, {type:'null'}]` — pas de `type` racine,
  // donc rejeté par le validateur de tool-calls de Groq exactement comme `allOf`.
  // Le `preprocess` conserve la tolérance au `null` explicite tout en émettant
  // `{ type: 'string', format: 'uuid' }`.
  managerId: z
    .preprocess(
      (value) => (value === null || value === '' ? undefined : value),
      uuidSchema.optional(),
    )
    .describe('ID du manager (optionnel)'),

  // Options d'idempotence
  idempotencyKey: z
    .string()
    .uuid()
    .optional()
    .describe("Clé d'idempotence pour éviter les doublons"),

  // Métadonnées
  metadata: z.record(z.string(), z.unknown()).optional().describe('Métadonnées additionnelles'),

  // Aucun bloc `options` : `skipUniquenessCheck` et `initialStatus` étaient
  // annoncés au modèle et n'ont JAMAIS été appliqués — l'appel au validateur
  // omet le 3e argument, et l'entité force `Pending`. Leur neutralité était un
  // accident, pas une défense. Les exposer coûtait des tokens à chaque
  // aller-retour et laissait croire au modèle qu'il pouvait désactiver un
  // contrôle d'unicité.
});

type CreateEmployeeInput = z.infer<typeof createEmployeeInputSchema>;

// ============================================
// 3. SANITIZER DE DONNÉES
// ============================================

/**
 * Sanitizer les données avant traitement
 */
export class EmployeeDataSanitizer {
  /**
   * Nettoie les champs texte pour éviter XSS et injections
   */
  static sanitize(input: CreateEmployeeInput): ValidatedEmployeeInput {
    return {
      firstName: this.sanitizeName(input.firstName),
      lastName: this.sanitizeName(input.lastName),
      email: this.sanitizeEmail(input.email),
      department: sanitizeHtml(input.department.trim()),
      position: sanitizeHtml(input.position.trim()),
      startDate: new Date(input.startDate).toISOString(),
      managerId: input.managerId || null,
      idempotencyKey: input.idempotencyKey,
      initialStatus: EmployeeStatus.Pending,
    };
  }

  private static sanitizeName(name: string): string {
    return sanitizeHtml(
      name
        .trim()
        .replace(/<[^>]*>/g, '') // Supprime les tags HTML
        .replace(/[^a-zA-ZÀ-ÿ\s'-]/g, ''), // Garde uniquement lettres, accents, apostrophes
    );
  }

  private static sanitizeEmail(email: string): string {
    return email.toLowerCase().trim();
  }
}

// ============================================
// 4. GESTION D'IDEMPOTENCE
// ============================================

/**
 * Gestionnaire d'idempotence
 * Garantit qu'une même opération n'est exécutée qu'une seule fois
 */
class IdempotencyManager {
  private static idempotencyCache = new Map<
    string,
    {
      result: CreateEmployeeResult;
      timestamp: number;
      ttl: number;
    }
  >();

  /**
   * Vérifie si une clé d'idempotence existe déjà
   */
  static check(key: string): CreateEmployeeResult | null {
    const cached = this.idempotencyCache.get(key);

    if (cached && Date.now() - cached.timestamp < cached.ttl) {
      return cached.result;
    }

    // Nettoyer les entrées expirées
    if (cached) {
      this.idempotencyCache.delete(key);
    }

    return null;
  }

  /**
   * Stocke le résultat d'une opération idempotente
   */
  static store(
    key: string,
    result: CreateEmployeeResult,
    ttlMs: number = 3600000, // 1 heure par défaut
  ): void {
    this.idempotencyCache.set(key, {
      result,
      timestamp: Date.now(),
      ttl: ttlMs,
    });
  }

  /**
   * Génère une clé d'idempotence déterministe basée sur les données
   */
  static generateKey(
    data: Pick<ValidatedEmployeeInput, 'email' | 'firstName' | 'lastName'>,
  ): string {
    const hash = createHash('sha256')
      .update(`${data.email}:${data.firstName}:${data.lastName}`)
      .digest('hex')
      .substring(0, 8);

    return `emp-${hash}`;
  }
}

// ============================================
// 5. VALIDATION MÉTIER
// ============================================

/**
 * Validateur de règles métier
 */
class EmployeeBusinessValidator {
  /**
   * Vérifie les règles métier avant création
   */
  static async validate(
    input: ValidatedEmployeeInput,
    repo: EmployeeRepository,
    options: CreateEmployeeOptions = {},
  ): Promise<string[]> {
    const warnings: string[] = [];
    const tracer = trace.getTracer('employee-validator');

    return await tracer.startActiveSpan('validate-business-rules', async (span) => {
      try {
        // 1. Vérifier l'unicité de l'email
        if (!options.skipUniquenessCheck) {
          const existingByEmail = await repo.findByEmail(input.email);
          if (existingByEmail) {
            throw new ConflictError(`Un employé avec l'email ${input.email} existe déjà`, {
              email: input.email,
              existingId: existingByEmail.id,
            });
          }
        }

        // 2. Vérifier que le manager existe si fourni
        if (input.managerId) {
          const manager = await repo.findById(input.managerId);
          if (!manager) {
            throw new ValidationError(`Le manager avec l'ID ${input.managerId} n'existe pas`, {
              managerId: input.managerId,
            });
          }

          // Vérifier que le manager est actif
          if (manager.status !== EmployeeStatus.Active) {
            warnings.push(`Le manager ${manager.firstName} ${manager.lastName} n'est pas actif`);
          }
        }

        // 3. Vérifier les doublons par nom (warning seulement)
        // (disabled - repo.findByNames not available)

        // 4. Vérifier la date de début
        const startDate = new Date(input.startDate);
        const maxFutureDate = new Date();
        maxFutureDate.setDate(maxFutureDate.getDate() + 90);

        if (startDate > maxFutureDate) {
          warnings.push('La date de début est dans plus de 90 jours');
        }

        if (startDate < new Date('2000-01-01')) {
          throw new ValidationError("La date de début ne peut pas être antérieure à l'an 2000");
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return warnings;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

// ============================================
// 6. USECASE PRINCIPAL
// ============================================

/**
 * Use case de création d'employé
 * Implémente le pattern Command avec transaction logique
 */
export class CreateEmployeeUseCase {
  private readonly tracer = trace.getTracer('create-employee-usecase');
  private readonly meter = metrics.getMeter('create-employee-metrics');

  // Métriques
  private readonly successCounter;
  private readonly failureCounter;
  private readonly durationHistogram;

  // Mutex par email pour éviter les race conditions
  private static emailMutexes = new Map<string, Mutex>();

  constructor(private readonly repo: EmployeeRepository) {
    // Initialiser les métriques
    this.successCounter = this.meter.createCounter('employee.created.success', {
      description: 'Nombre de créations réussies',
    });

    this.failureCounter = this.meter.createCounter('employee.created.failure', {
      description: 'Nombre de créations échouées',
    });

    this.durationHistogram = this.meter.createHistogram('employee.created.duration', {
      description: "Durée de création d'employé",
      unit: 'ms',
    });
  }

  /**
   * Exécute la création d'un employé
   */
  async execute(rawInput: unknown, ctx?: CreateEmployeeContext): Promise<CreateEmployeeResult> {
    const startTime = Date.now();

    return await this.tracer.startActiveSpan('create-employee', async (span) => {
      try {
        // 1. Validation et parsing de l'input
        const input = this.validateAndParseInput(rawInput);

        // 2. Ajouter le contexte au span
        span.setAttributes({
          'employee.email': input.email,
          'employee.department': input.department,
          'request.id': ctx?.requestId || 'unknown',
          'idempotency.key': input.idempotencyKey || 'none',
        });

        // 3. Vérifier l'idempotence
        if (input.idempotencyKey) {
          const idempotentResult = IdempotencyManager.check(input.idempotencyKey);
          if (idempotentResult) {
            logger.info('Opération idempotente détectée', {
              idempotencyKey: input.idempotencyKey,
              requestId: ctx?.requestId,
            });

            span.setAttribute('idempotent', true);
            return idempotentResult;
          }
        }

        // 4. Acquérir un mutex par email pour éviter les race conditions
        const mutex = this.getOrCreateEmailMutex(input.email);
        const release = await mutex.acquire();

        try {
          // 5. Valider les règles métier
          const warnings = await EmployeeBusinessValidator.validate(input, this.repo);

          // 6. Créer l'entité domaine
          const employee = createEmployee({
            id: input.idempotencyKey
              ? this.generateDeterministicId(input.idempotencyKey)
              : crypto.randomUUID(),
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            department: input.department,
            position: input.position,
            startDate: input.startDate,
            managerId: input.managerId,
          });

          // 7. Sauvegarder avec retry
          await withRetry(
            async () => {
              await this.repo.save(employee);
            },
            {
              maxAttempts: 3,
              strategy: {
                type: 'exponential',
                initialDelay: 100,
                maxDelay: 1000,
              },
              onRetry: (retryContext) => {
                logger.warn('Retry save employee', {
                  attempt: retryContext.attempt,
                  error: (retryContext.error as Error).message,
                  employeeId: employee.id,
                });
              },
              shouldRetry: (error) => {
                // Ne pas retry sur les erreurs de conflit ou validation
                return !(error instanceof ConflictError || error instanceof ValidationError);
              },
            },
          );

          // 8. Convertir en DTO
          const employeeDto = EmployeeMapper.toDto(employee);

          // 9. Construire le résultat
          const result: CreateEmployeeResult = {
            employee: employeeDto,
            idempotent: false,
            warnings: warnings.length > 0 ? warnings : undefined,
          };

          // 10. Stocker pour idempotence
          if (input.idempotencyKey) {
            IdempotencyManager.store(input.idempotencyKey, result);
          }

          // 11. Métriques
          this.successCounter.add(1, {
            department: input.department,
            status: input.initialStatus,
          });

          // 12. Logging structuré
          logger.info('Employé créé avec succès', {
            employeeId: employee.id,
            email: employee.email,
            department: employee.department,
            requestId: ctx?.requestId,
            duration: Date.now() - startTime,
            warnings,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('employee.id', employee.id);

          return result;
        } finally {
          release(); // Toujours libérer le mutex
        }
      } catch (error) {
        // Gestion d'erreur centralisée
        return this.handleError(error, startTime, ctx);
      } finally {
        span.end();
        this.durationHistogram.record(Date.now() - startTime);
      }
    });
  }

  /**
   * Valide et parse l'input brut
   */
  private validateAndParseInput(rawInput: unknown): ValidatedEmployeeInput {
    try {
      const parsed = createEmployeeInputSchema.parse(rawInput);
      return EmployeeDataSanitizer.sanitize(parsed);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError(
          "Données d'entrée invalides",
          error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
            code: e.code,
          })),
        );
      }
      throw error;
    }
  }

  /**
   * Génère un ID déterministe basé sur la clé d'idempotence
   */
  private generateDeterministicId(idempotencyKey: string): string {
    const hash = createHash('sha256').update(idempotencyKey).digest('hex');

    // Convertir en UUID v5 format
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      '5' + hash.substring(13, 16),
      '8' + hash.substring(17, 20),
      hash.substring(20, 32),
    ].join('-');
  }

  /**
   * Gestion centralisée des erreurs
   */
  private handleError(error: unknown, startTime: number, ctx?: CreateEmployeeContext): never {
    const duration = Date.now() - startTime;

    // Logger l'erreur
    logger.error("Échec de création d'employé", {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              ...(error instanceof AppError && { code: error.code }),
            }
          : error,
      duration,
      requestId: ctx?.requestId,
    });

    // Incrémenter le compteur d'échecs
    this.failureCounter.add(1, {
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
    });

    // Transformer les erreurs inconnues
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof z.ZodError) {
      throw new ValidationError('Données invalides', error.errors);
    }

    // Erreur inconnue -> erreur générique
    throw new DatabaseError("Une erreur inattendue est survenue lors de la création de l'employé", {
      originalError: error,
    });
  }

  /**
   * Obtient ou crée un mutex pour un email
   */
  private getOrCreateEmailMutex(email: string): Mutex {
    const key = email.toLowerCase();

    if (!CreateEmployeeUseCase.emailMutexes.has(key)) {
      CreateEmployeeUseCase.emailMutexes.set(key, new Mutex());
    }

    return CreateEmployeeUseCase.emailMutexes.get(key)!;
  }
}

// ============================================
// 7. FACTORY FUNCTION (Interface originale)
// ============================================

/**
 * Factory function pour créer le tool Mastra
 * Maintient la compatibilité avec l'interface existante
 */
export function makeCreateEmployee(repo: EmployeeRepository) {
  const useCase = new CreateEmployeeUseCase(repo);

  return createTool({
    id: 'createEmployee',
    description:
      "Crée un nouvel employé dans le système d'onboarding avec validation métier complète",

    inputSchema: createEmployeeInputSchema,

    execute: async (rawInput, toolContext) => {
      const tc = toolContext as any;
      // Extraire le contexte de la requête
      const ctx: CreateEmployeeContext = {
        requestId: tc.requestId || crypto.randomUUID(),
        correlationId: tc.correlationId || crypto.randomUUID(),
        userId: tc.userId,
        tenantId: tc.tenantId,
        ipAddress: tc.ipAddress,
      };

      const validatedInput = createEmployeeInputSchema.parse(rawInput);

      // Ajouter le contexte au log (via le payload additionnel)
      logger.info('Début workflow createEmployee', {
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        email: validatedInput.email,
      });

      try {
        // Exécuter le use case
        const result = await useCase.execute(rawInput, ctx);

        logger.info('Tool exécuté avec succès', {
          employeeId: result.employee.id,
          idempotent: result.idempotent,
        });

        return result;
      } catch (error) {
        logger.error('Tool en erreur', { error });
        throw error;
      }
    },
  });
}

// ============================================
// 8. TYPES RÉEXPORTÉS
// ============================================

export type {
  CreateEmployeeInput,
  CreateEmployeeContext,
  CreateEmployeeOptions,
  CreateEmployeeResult,
  ValidatedEmployeeInput,
};
