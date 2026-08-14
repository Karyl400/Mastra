// ============================================
// logger.ts - Production-Grade Structured Logger
// Standards 2026: Pino-compatible, OpenTelemetry, Anti-circular
// ============================================

import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';
import { randomUUID } from 'crypto';

// ============================================
// 1. TYPES
// ============================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  sessionId?: string;
  userId?: string;
  data: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  };
}

interface LoggerOptions {
  /** Niveau de log minimum */
  level: LogLevel;
  /** Contexte par défaut injecté dans tous les logs */
  baseContext: Record<string, unknown>;
  /** Activer/désactiver la sortie console */
  enabled: boolean;
  /** Fonction de transport personnalisée (pour envoyer vers Grafana Loki, Datadog, etc.) */
  transport?: (entry: LogEntry) => void | Promise<void>;
  /** Taille maximale d'un objet avant troncature */
  maxObjectDepth: number;
  /** Nombre maximal de clés dans un objet avant échantillonnage */
  maxObjectKeys: number;
}

interface ChildLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | Error, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  fatal(msg: string | Error, ...args: unknown[]): void;
  child(context: Record<string, unknown>): ChildLogger;
  getLevel(): LogLevel;
  setLevel(level: LogLevel): void;
}

// ============================================
// 2. CONSTANTES DE MASQUAGE PII
// ============================================

/**
 * Liste exhaustive des clés à masquer (insensible à la casse)
 * Inspiré de : OWASP, GDPR, PCI-DSS, HIPAA
 */
const PII_KEYS = new Set([
  // Identifiants personnels
  'email',
  'mail',
  'e-mail',
  'firstname',
  'lastname',
  'fullname',
  'name',
  'surname',
  'phone',
  'telephone',
  'mobile',
  'cell',
  'fax',
  'ssn',
  'socialsecurity',
  'social_security',
  'nin',
  'nationalid',
  'passport',
  'driverlicense',
  'driving_license',
  'birthdate',
  'dateofbirth',
  'birth_date',
  'dob',
  'address',
  'street',
  'city',
  'zipcode',
  'postalcode',
  'postal_code',
  'country',
  'state',
  'region',
  'ip',
  'ipaddress',
  'ip_address',
  'mac',
  'macaddress',

  // Authentification & Sécurité
  'password',
  'passwd',
  'pwd',
  'secret',
  'passcode',
  'pin',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'privatekey',
  'private_key',
  'publickey',
  'public_key',
  'certificate',
  'cert',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'sessionid',
  'session_id',
  'jwt',
  'otp',
  'mfa',
  'tfa',
  'twofactor',

  // Paiement (PCI-DSS)
  'creditcard',
  'credit_card',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'cvv2',
  'cid',
  'iban',
  'bic',
  'swift',
  'accountnumber',
  'account_number',
  'bankaccount',

  // Santé (HIPAA)
  'medicalrecord',
  'medical_record',
  'healthrecord',
  'patientid',
  'patient_id',
  'diagnosis',
  'prescription',
  'insurance',
  'insurancenumber',

  // Biométrie
  'fingerprint',
  'retina',
  'facial',
  'biometric',
  'dna',
  'genetic',

  // Documents
  'passportnumber',
  'passport_number',
  'documentid',
  'document_id',
  'taxid',
  'tax_id',
  'vat',

  // ── PROSE ÉCRITE PAR UN HUMAIN (ajouté le 2026-08-14) ──────────────────────
  // Recensé dans `TODO.md` [0 ter] : `maskPii` ne couvrait ni `text`, ni `content`, ni
  // `body`. Ce n'était pas un incident — aucun site d'appel ne les journalisait — c'était
  // la GARANTIE qui manquait, et elle manquait précisément sur les champs les plus
  // sensibles du produit :
  //   `text`      le message Slack brut de la personne ;
  //   `content`   le corps d'un document (`documents.content`) ;
  //   `body`      le corps d'un email (`notifications.body`) ;
  //   `fact`      un fait épinglé — « souviens-toi que… », donc écrit pour être gardé ;
  //   `dailywork` / `workstyle`  ce que la personne a dit d'elle à l'entretien.
  //
  // ⚠️ `message` est délibérément ABSENT : c'est le champ des messages d'ERREUR dans tout le
  // dépôt, et le masquer supprimerait le diagnostic au lieu de protéger quelqu'un.
  'text',
  'content',
  'body',
  'fact',
  'dailywork',
  'daily_work',
  'workstyle',
  'work_style',
]);

/**
 * Patterns regex pour détection de PII dans les valeurs
 */
const PII_VALUE_PATTERNS = [
  // Email
  { pattern: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, mask: '***@***.***' },
  // JWT
  { pattern: /^eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$/, mask: '***JWT***' },
  // API Keys génériques (sk-, pk-, etc.)
  { pattern: /^(?:sk|pk|rk)-[a-zA-Z0-9]{20,}$/, mask: '***API_KEY***' },
  // Numéros de carte bancaire (Luhn-like)
  {
    pattern: /^\d{13,19}$/,
    mask: '****-****-****-****',
    validator: (v: string) => v.replace(/\s/g, '').length >= 13,
  },
];

// ============================================
// 3. FONCTIONS DE MASQUAGE AVANCÉ
// ============================================

/**
 * Vérifie si une valeur est un objet "plain" (pas Date, RegExp, Buffer, etc.)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Vérifie si un objet est potentiellement cyclique
 */
function hasCircularReference(obj: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof obj !== 'object' || obj === null) return false;

  if (seen.has(obj as object)) return true;
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    return obj.some((item) => hasCircularReference(item, seen));
  }

  if (isPlainObject(obj)) {
    return Object.values(obj).some((val) => hasCircularReference(val, seen));
  }

  return false;
}

/**
 * Masque les PII de manière récursive avec protection anti-circulaire
 * et gestion des types spéciaux
 */
function maskPii(
  obj: unknown,
  options: {
    depth?: number;
    maxDepth?: number;
    seen?: WeakSet<object>;
    keyPath?: string[];
  } = {},
): unknown {
  const { depth = 0, maxDepth = 10, seen = new WeakSet<object>(), keyPath = [] } = options;

  // Protection profondeur
  if (depth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  // Types primitifs
  if (typeof obj !== 'object' || obj === null) {
    return maskPrimitiveValue(obj, keyPath);
  }

  // Protection anti-circulaire
  if (seen.has(obj as object)) {
    return '[CIRCULAR_REFERENCE]';
  }

  // Types spéciaux non modifiables
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (obj instanceof RegExp) {
    return obj.toString();
  }
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: maskPrimitiveValue(obj.message, [...keyPath, 'message']),
      stack: obj.stack ? '[STACK_TRACE]' : undefined,
      cause: obj.cause
        ? maskPii(obj.cause, { depth: depth + 1, maxDepth, seen, keyPath: [...keyPath, 'cause'] })
        : undefined,
    };
  }
  if (Buffer.isBuffer(obj)) {
    return '[BUFFER:' + obj.length + 'bytes]';
  }
  if (obj instanceof Map) {
    return '[MAP:' + obj.size + 'entries]';
  }
  if (obj instanceof Set) {
    return '[SET:' + obj.size + 'entries]';
  }
  if (typeof obj === 'function') {
    return '[FUNCTION:' + (obj.name || 'anonymous') + ']';
  }

  // Arrays
  if (Array.isArray(obj)) {
    seen.add(obj as object);
    return obj.map((item, index) =>
      maskPii(item, {
        depth: depth + 1,
        maxDepth,
        seen: new WeakSet<object>(),
        keyPath: [...keyPath, String(index)],
      }),
    );
  }

  // Objets
  if (isPlainObject(obj)) {
    seen.add(obj as object);
    const masked: Record<string, unknown> = {};

    const entries = Object.entries(obj);
    const isLargeObject = entries.length > 50;
    const sampledEntries = isLargeObject
      ? entries.filter(() => Math.random() < 0.5) // Échantillonnage 50% pour gros objets
      : entries;

    for (const [key, value] of sampledEntries) {
      const newKeyPath = [...keyPath, key];

      // Vérifier si la clé est une PII
      if (isPiiKey(key)) {
        masked[key] = '[REDACTED:' + getPiiCategory(key) + ']';
        continue;
      }

      // Vérifier si la valeur correspond à un pattern PII
      if (typeof value === 'string' && isPiiValue(value)) {
        masked[key] = maskPiiValue(value);
        continue;
      }

      // Récursion
      masked[key] = maskPii(value, {
        depth: depth + 1,
        maxDepth,
        seen: new WeakSet<object>(),
        keyPath: newKeyPath,
      });
    }

    if (isLargeObject && sampledEntries.length < entries.length) {
      masked['_sampling_note'] =
        `Object had ${entries.length} keys, ${sampledEntries.length} sampled for logging`;
    }

    return masked;
  }

  // Fallback pour types inconnus
  return '[UNKNOWN_TYPE:' + typeof obj + ']';
}

/**
 * Masque une valeur primitive si elle correspond à un pattern PII
 */
function maskPrimitiveValue(value: unknown, keyPath: string[]): unknown {
  if (typeof value === 'string' && isPiiValue(value)) {
    return maskPiiValue(value);
  }
  return value;
}

/**
 * Vérifie si une clé est une PII (insensible à la casse)
 */
function isPiiKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return PII_KEYS.has(normalized);
}

/**
 * Retourne la catégorie PII pour une clé
 */
function getPiiCategory(key: string): string {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (['email', 'mail', 'e-mail'].includes(normalized)) return 'EMAIL';
  if (['password', 'passwd', 'pwd', 'secret'].includes(normalized)) return 'CREDENTIAL';
  if (['token', 'accesstoken', 'refreshtoken'].includes(normalized)) return 'TOKEN';
  if (['creditcard', 'cardnumber', 'cvv', 'iban'].includes(normalized)) return 'PCI';
  if (['ssn', 'socialsecurity', 'passport'].includes(normalized)) return 'PII';
  return 'SENSITIVE';
}

/**
 * Vérifie si une valeur correspond à un pattern PII
 */
function isPiiValue(value: string): boolean {
  for (const { pattern, validator } of PII_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      if (validator) {
        return validator(value);
      }
      return true;
    }
  }
  return false;
}

/**
 * Masque une valeur selon son pattern
 */
function maskPiiValue(value: string): string {
  for (const { pattern, mask } of PII_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return mask;
    }
  }
  return '[REDACTED]';
}

// ============================================
// 4. LOGGER IMPLÉMENTATION
// ============================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/**
 * Récupère le contexte OpenTelemetry actif
 */
function getOtelContext(): { traceId?: string; spanId?: string } {
  try {
    const span = trace.getSpan(context.active());
    if (span) {
      const spanContext = span.spanContext();
      return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      };
    }
  } catch {
    // OpenTelemetry non configuré, ignorer silencieusement
  }
  return {};
}

/**
 * Logger principal
 */
class Logger implements ChildLogger {
  private level: LogLevel;
  private baseContext: Record<string, unknown>;
  private enabled: boolean;
  private transport?: (entry: LogEntry) => void | Promise<void>;
  private maxObjectDepth: number;
  private maxObjectKeys: number;
  private requestId: string;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.level = (process.env.LOG_LEVEL as LogLevel) || options.level || 'info';
    this.baseContext = options.baseContext || {};
    this.enabled = options.enabled !== false;
    this.transport = options.transport;
    this.maxObjectDepth = options.maxObjectDepth || 10;
    this.maxObjectKeys = options.maxObjectKeys || 50;
    this.requestId = (this.baseContext.requestId as string) || randomUUID();
  }

  // ============================================
  // MÉTHODES PUBLIQUES
  // ============================================

  info(msg: string, ...args: unknown[]): void {
    this.log('info', msg, args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.log('warn', msg, args);
  }

  error(msg: string | Error, ...args: unknown[]): void {
    if (msg instanceof Error) {
      this.log('error', msg.message, [msg, ...args]);
    } else {
      this.log('error', msg, args);
    }
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log('debug', msg, args);
  }

  fatal(msg: string | Error, ...args: unknown[]): void {
    if (msg instanceof Error) {
      this.log('fatal', msg.message, [msg, ...args]);
    } else {
      this.log('fatal', msg, args);
    }
  }

  /**
   * Crée un logger enfant avec contexte additionnel
   */
  child(context: Record<string, unknown>): ChildLogger {
    const childLogger = new Logger({
      level: this.level,
      baseContext: { ...this.baseContext, ...context },
      enabled: this.enabled,
      transport: this.transport,
      maxObjectDepth: this.maxObjectDepth,
      maxObjectKeys: this.maxObjectKeys,
    });

    // Hériter du requestId si non fourni
    if (!context.requestId && this.requestId) {
      childLogger.requestId = this.requestId;
    }

    return childLogger;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  // ============================================
  // MÉTHODES PRIVÉES
  // ============================================

  private log(level: LogLevel, message: string, args: unknown[]): void {
    // Vérifier le niveau
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
      return;
    }

    if (!this.enabled) {
      return;
    }

    try {
      const entry = this.buildLogEntry(level, message, args);
      this.writeLogEntry(level, entry);
    } catch (error) {
      // Fallback en cas d'échec du logging structuré
      console.error(`[LOGGER_ERROR] Failed to log message: ${message}`, error);
    }
  }

  /**
   * Construit l'entrée de log structurée
   */
  private buildLogEntry(level: LogLevel, message: string, args: unknown[]): LogEntry {
    const { traceId, spanId } = getOtelContext();

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      traceId,
      spanId,
      requestId: this.requestId,
      data: [],
    };

    // Ajouter le contexte de base
    if (Object.keys(this.baseContext).length > 0) {
      Object.assign(entry, this.baseContext);
    }

    // Traiter les arguments
    if (args.length === 1 && args[0] instanceof Error) {
      entry.error = {
        name: args[0].name,
        message: args[0].message,
        stack: args[0].stack,
        cause: args[0].cause
          ? maskPii(args[0].cause, { maxDepth: this.maxObjectDepth })
          : undefined,
      };
    } else if (args.length > 0) {
      // Masquer les PII dans les données
      const maskedArgs = args.map((arg) => maskPii(arg, { maxDepth: this.maxObjectDepth }));

      if (maskedArgs.length === 1) {
        entry.data = maskedArgs[0];
      } else {
        entry.data = maskedArgs;
      }
    }

    return entry;
  }

  /**
   * Écrit l'entrée de log vers toutes les destinations
   */
  private writeLogEntry(level: LogLevel, entry: LogEntry): void {
    // 1. Sortie console (JSON structuré)
    const jsonString = this.safeStringify(entry);

    switch (level) {
      case 'debug':
        console.debug(jsonString);
        break;
      case 'info':
        console.log(jsonString);
        break;
      case 'warn':
        console.warn(jsonString);
        break;
      case 'error':
      case 'fatal':
        console.error(jsonString);
        break;
    }

    // 2. Transport personnalisé (Grafana Loki, Datadog, etc.)
    if (this.transport) {
      // Ne pas bloquer la boucle d'événements
      setImmediate(() => {
        this.transport?.(entry)?.catch((err) => {
          console.error('[LOGGER_TRANSPORT_ERROR]', err);
        });
      });
    }

    // 3. En cas d'erreur fatale, forcer le flush
    if (level === 'fatal') {
      console.error('[FATAL] Application will terminate');
    }
  }

  /**
   * JSON.stringify sécurisé (gère les objets problématiques)
   */
  private safeStringify(obj: unknown): string {
    try {
      return JSON.stringify(obj);
    } catch {
      // Fallback en cas d'échec de stringify
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: '[SERIALIZATION_ERROR] Failed to stringify log entry',
        error: 'Circular reference or non-serializable object',
      });
    }
  }
}

// ============================================
// 5. EXPORT DU LOGGER PAR DÉFAUT
// ============================================

/**
 * Instance du logger par défaut
 */
export const logger: ChildLogger = new Logger({
  level: (process.env.LOG_LEVEL as LogLevel) || 'info',
  baseContext: {
    service: process.env.SERVICE_NAME || 'unknown',
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '0.0.0',
  },
});

/**
 * Fonction pour créer un logger personnalisé
 */
export function createLogger(options: Partial<LoggerOptions>): ChildLogger {
  return new Logger(options);
}

// ============================================
// 6. EXPORTS
// ============================================

export {
  Logger,
  maskPii,
  isPiiKey,
  PII_KEYS,
  type LogLevel,
  type LogEntry,
  type LoggerOptions,
  type ChildLogger,
};
