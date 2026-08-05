// ============================================
// retry.ts - Production-Grade Retry Utility
// Standards 2026: Jitter, AbortSignal, Timeout, Circuit Breaker
// ============================================

import { trace, SpanStatusCode } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { logger } from './logger';

// ============================================
// 1. TYPES
// ============================================

/** Stratégies de backoff supportées */
type BackoffStrategy =
  | { type: 'fixed'; delay: number }
  | { type: 'exponential'; initialDelay: number; maxDelay: number; factor?: number }
  | { type: 'linear'; initialDelay: number; increment: number; maxDelay: number }
  | { type: 'decorrelated'; baseDelay: number; maxDelay: number };

/** Options complètes de retry */
interface RetryOptions {
  /** Nombre maximum de tentatives (incluant la première) */
  maxAttempts: number;
  
  /** Stratégie de backoff (défaut: exponential avec jitter) */
  strategy?: BackoffStrategy;
  
  /** Timeout par tentative en ms (défaut: 30000 = 30s) */
  attemptTimeout?: number;
  
  /** Durée totale maximale en ms (défaut: 300000 = 5min) */
  maxTotalDuration?: number;
  
  /** Signal pour annuler les retries */
  signal?: AbortSignal;
  
  /** Jitter à appliquer (0-1, défaut: 0.1 = ±10%) */
  jitter?: number;
  
  /** Callback appelé avant chaque retry */
  onRetry?: (context: RetryContext) => void;
  
  /** Détermine si l'erreur est retryable */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  
  /** Nom de l'opération (pour logs et traces) */
  operationName?: string;
  
  /** Identifiant unique pour le cycle de retry */
  retryId?: string;
}

/** Contexte passé au callback onRetry */
interface RetryContext {
  attempt: number;
  maxAttempts: number;
  error: unknown;
  delayMs: number;
  totalElapsedMs: number;
  retryId: string;
  operationName: string;
}

/** Résultat d'une opération avec retry */
interface RetryResult<T> {
  result: T;
  attempts: number;
  totalDurationMs: number;
  retried: boolean;
}

/** Circuit breaker simple */
interface CircuitState {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'half-open' | 'open';
}

// ============================================
// 2. CIRCUIT BREAKER (Optionnel)
// ============================================

class CircuitBreaker {
  private static circuits = new Map<string, CircuitState>();
  
  private static readonly FAILURE_THRESHOLD = 5;
  private static readonly RESET_TIMEOUT = 30000; // 30 secondes avant half-open
  private static readonly HALF_OPEN_SUCCESSES = 2;
  
  /**
   * Vérifie si le circuit est ouvert pour une opération
   */
  static isOpen(circuitName: string): boolean {
    const circuit = this.circuits.get(circuitName);
    if (!circuit) return false;
    
    if (circuit.state === 'open') {
      // Vérifier si on peut passer en half-open
      if (Date.now() - circuit.lastFailure > this.RESET_TIMEOUT) {
        circuit.state = 'half-open';
        return false;
      }
      return true;
    }
    
    return false;
  }
  
  /**
   * Enregistre un succès
   */
  static recordSuccess(circuitName: string): void {
    const circuit = this.circuits.get(circuitName);
    if (circuit && circuit.state === 'half-open') {
      circuit.failures--;
      if (circuit.failures <= 0) {
        circuit.state = 'closed';
        circuit.failures = 0;
      }
    }
  }
  
  /**
   * Enregistre un échec
   */
  static recordFailure(circuitName: string): void {
    let circuit = this.circuits.get(circuitName);
    
    if (!circuit) {
      circuit = { failures: 0, lastFailure: 0, state: 'closed' };
      this.circuits.set(circuitName, circuit);
    }
    
    circuit.failures++;
    circuit.lastFailure = Date.now();
    
    if (circuit.state === 'half-open') {
      circuit.state = 'open';
    } else if (circuit.failures >= this.FAILURE_THRESHOLD) {
      circuit.state = 'open';
    }
  }
  
  /**
   * Nettoie les circuits expirés (à appeler périodiquement)
   */
  static cleanup(): void {
    const now = Date.now();
    for (const [name, circuit] of this.circuits) {
      if (circuit.state === 'closed' && now - circuit.lastFailure > 3600000) {
        this.circuits.delete(name);
      }
    }
  }
}

// ============================================
// 3. GÉNÉRATION DE DÉLAI AVEC JITTER
// ============================================

/**
 * Calcule le délai de backoff avec jitter
 * 
 * Le jitter est essentiel pour éviter le "thundering herd" :
 * quand N instances échouent simultanément, sans jitter elles
 * réessaient toutes exactement au même moment, surchargeant le service.
 */
function calculateBackoff(
  strategy: BackoffStrategy,
  attempt: number,
  jitterFactor: number = 0.1
): number {
  let baseDelay: number;
  
  switch (strategy.type) {
    case 'fixed':
      baseDelay = strategy.delay;
      break;
      
    case 'exponential': {
      const factor = strategy.factor || 2;
      baseDelay = Math.min(
        strategy.initialDelay * Math.pow(factor, attempt - 1),
        strategy.maxDelay
      );
      break;
    }
      
    case 'linear':
      baseDelay = Math.min(
        strategy.initialDelay + (attempt - 1) * strategy.increment,
        strategy.maxDelay
      );
      break;
      
    case 'decorrelated': {
      // Decorrelated Jitter (AWS style)
      // Plus performant que full jitter pour les systèmes distribués
      const cap = Math.min(
        strategy.baseDelay * Math.pow(2, attempt - 1),
        strategy.maxDelay
      );
      baseDelay = strategy.baseDelay + Math.random() * (cap - strategy.baseDelay);
      // Appliquer un jitter supplémentaire si demandé
      return baseDelay + (Math.random() - 0.5) * 2 * baseDelay * jitterFactor;
    }
      
    default:
      baseDelay = 1000;
  }
  
  // Appliquer le jitter : délai ± jitterFactor%
  // Exemple : délai 1000ms avec jitter 0.1 → entre 900ms et 1100ms
  const jitter = (Math.random() - 0.5) * 2 * baseDelay * jitterFactor;
  return Math.max(0, baseDelay + jitter);
}

// ============================================
// 4. DÉTECTION DES ERREURS RETRYABLES
// ============================================

/**
 * Erreurs qui sont généralement retryables
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const retryableMessages = [
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
      'ENOTFOUND', 'EAI_AGAIN',
      '429', '503', '502', '504', // HTTP
      'rate limit', 'too many requests',
      'temporary', 'transient',
      'deadlock', 'lock',
    ];
    
    const message = error.message.toLowerCase();
    if (retryableMessages.some(m => message.includes(m.toLowerCase()))) {
      return true;
    }
    
    // Les erreurs réseau sont retryables
    if (error.name === 'FetchError' || error.name === 'NetworkError') {
      return true;
    }
  }
  
  return false;
}

// ============================================
// 5. FONCTION PRINCIPALE withRetry
// ============================================

/**
 * Exécute une fonction asynchrone avec retry automatique
 * 
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetch('https://api.example.com'),
 *   {
 *     maxAttempts: 3,
 *     strategy: { type: 'exponential', initialDelay: 1000, maxDelay: 10000 },
 *     shouldRetry: (error) => error instanceof NetworkError,
 *     operationName: 'fetchUserData',
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions
): Promise<RetryResult<T>> {
  const {
    maxAttempts,
    strategy = { type: 'exponential', initialDelay: 1000, maxDelay: 30000 },
    attemptTimeout = 30000,
    maxTotalDuration = 300000,
    signal: externalSignal,
    jitter = 0.1,
    onRetry,
    shouldRetry,
    operationName = 'anonymous',
    retryId = randomUUID(),
  } = options;
  
  const tracer = trace.getTracer('retry-utility');
  const span = tracer.startSpan(`retry.${operationName}`);
  
  const startTime = Date.now();
  let lastError: unknown;
  
  span.setAttributes({
    'retry.id': retryId,
    'retry.operation': operationName,
    'retry.max_attempts': maxAttempts,
    'retry.strategy': strategy.type,
    'retry.jitter': jitter,
  });
  
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const totalElapsed = Date.now() - startTime;
      
      // Vérifier la durée totale maximale
      if (totalElapsed > maxTotalDuration) {
        throw new RetryExhaustedError(
          `Retry total duration exceeded (${maxTotalDuration}ms)`,
          attempt,
          totalElapsed,
          lastError
        );
      }
      
      // Vérifier le signal d'annulation externe
      if (externalSignal?.aborted) {
        throw new RetryAbortedError(
          'Retry aborted by external signal',
          attempt,
          externalSignal.reason
        );
      }
      
      // Vérifier le circuit breaker si configuré
      if (CircuitBreaker.isOpen(operationName)) {
        throw new CircuitOpenError(
          `Circuit breaker is open for operation "${operationName}"`,
          attempt
        );
      }
      
      try {
        // Créer un signal combiné (timeout + annulation externe)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(new Error('Attempt timeout')), attemptTimeout);
        
        // Combiner avec le signal externe
        if (externalSignal) {
          externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
        }
        
        try {
          // Exécuter la fonction
          const result = await fn(controller.signal);
          
          // Succès
          clearTimeout(timeoutId);
          
          CircuitBreaker.recordSuccess(operationName);
          
          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('retry.attempts', attempt);
          span.setAttribute('retry.total_duration_ms', Date.now() - startTime);
          span.setAttribute('retry.retried', attempt > 1);
          
          return {
            result,
            attempts: attempt,
            totalDurationMs: Date.now() - startTime,
            retried: attempt > 1,
          };
          
        } finally {
          clearTimeout(timeoutId);
        }
        
      } catch (error) {
        lastError = error;
        const totalElapsed = Date.now() - startTime;
        
        // Vérifier si on doit retry
        const retryable = shouldRetry
          ? shouldRetry(error, attempt)
          : isRetryableError(error);
        
        if (!retryable || attempt >= maxAttempts) {
          CircuitBreaker.recordFailure(operationName);
          throw error;
        }
        
        CircuitBreaker.recordFailure(operationName);
        
        // Calculer le délai
        const delayMs = calculateBackoff(strategy, attempt, jitter);
        
        // Logger le retry
        logger.warn('Operation failed, retrying', {
          retryId,
          operationName,
          attempt,
          maxAttempts,
          delayMs,
          totalElapsedMs: totalElapsed,
          error: error instanceof Error ? error.message : String(error),
        });
        
        // Callback onRetry
        if (onRetry) {
          onRetry({
            attempt,
            maxAttempts,
            error,
            delayMs,
            totalElapsedMs: totalElapsed,
            retryId,
            operationName,
          });
        }
        
        // Mettre à jour le span
        span.addEvent('retry.attempt', {
          'retry.attempt.number': attempt,
          'retry.attempt.delay_ms': delayMs,
          'retry.attempt.error': error instanceof Error ? error.message : String(error),
        });
        
        // Attendre avant le prochain essai
        await sleep(delayMs, externalSignal);
      }
    }
    
    // Ne devrait jamais arriver (la boucle throw avant)
    throw lastError;
    
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    span.setAttribute('retry.attempts', 'exhausted');
    span.setAttribute('retry.total_duration_ms', Date.now() - startTime);
    throw error;
    
  } finally {
    span.end();
  }
}

// ============================================
// 6. UTILITAIRES
// ============================================

/**
 * Sleep avec support d'annulation
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new RetryAbortedError('Sleep aborted', 0, signal.reason));
      }, { once: true });
    }
  });
}

// ============================================
// 7. ERREURS PERSONNALISÉES
// ============================================

/** Erreur levée quand tous les retries sont épuisés */
export class RetryExhaustedError extends Error {
  public readonly code = 'RETRY_EXHAUSTED';
  
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly totalDurationMs: number,
    public readonly lastError: unknown
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

/** Erreur levée quand le retry est annulé */
export class RetryAbortedError extends Error {
  public readonly code = 'RETRY_ABORTED';
  
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly reason?: unknown
  ) {
    super(message);
    this.name = 'RetryAbortedError';
  }
}

/** Erreur levée quand le circuit breaker est ouvert */
export class CircuitOpenError extends Error {
  public readonly code = 'CIRCUIT_OPEN';
  
  constructor(
    message: string,
    public readonly attempts: number
  ) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

// ============================================
// 8. FONCTIONS DE CONVENANCE
// ============================================

/**
 * Version simplifiée qui retourne directement le résultat (pas de RetryResult)
 */
export async function withSimpleRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { result } = await withRetry(fn, options);
  return result;
}

/**
 * Retry avec des options par défaut pour les appels API
 */
export async function withApiRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  return withSimpleRetry(fn, {
    maxAttempts: 3,
    strategy: { type: 'exponential', initialDelay: 500, maxDelay: 5000 },
    attemptTimeout: 15000,
    maxTotalDuration: 60000,
    jitter: 0.2,
    shouldRetry: (error) => isRetryableError(error),
    operationName: options?.operationName || 'api-call',
    ...options,
  });
}

/**
 * Retry avec des options pour les appels base de données
 */
export async function withDatabaseRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  return withSimpleRetry(fn, {
    maxAttempts: 5,
    strategy: { type: 'exponential', initialDelay: 100, maxDelay: 3000 },
    attemptTimeout: 10000,
    maxTotalDuration: 30000,
    jitter: 0.3,
    shouldRetry: (error) => {
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return msg.includes('deadlock') || 
               msg.includes('connection') || 
               msg.includes('timeout');
      }
      return false;
    },
    operationName: options?.operationName || 'db-query',
    ...options,
  });
}

// ============================================
// 9. EXPORTS
// ============================================

export {
  isRetryableError,
  CircuitBreaker,
};

export type {
  RetryOptions,
  RetryContext,
  RetryResult,
  BackoffStrategy,
};