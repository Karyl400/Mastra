/**
 * Vérification de signature Slack Events API.
 *
 * Slack signe CHAQUE requête (y compris `url_verification`, envoyé avant même que
 * l'app soit vérifiée) avec HMAC-SHA256 sur la chaîne `v0:{timestamp}:{rawBody}`.
 *
 * Deux règles non négociables :
 *  1. Le HMAC doit être calculé sur le corps BRUT (`await c.req.text()`). Parser puis
 *     re-sérialiser en JSON change les espaces / l'ordre des clés et casse la signature.
 *  2. La comparaison doit être à temps constant (`crypto.timingSafeEqual`) pour ne pas
 *     fuiter la signature attendue via un oracle temporel.
 *
 * Rejouabilité : Slack recommande de rejeter toute requête dont le timestamp dépasse
 * 5 minutes d'écart avec l'horloge locale.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Version du schéma de signature Slack (préfixe de `X-Slack-Signature`). */
export const SLACK_SIGNATURE_VERSION = 'v0';

/** Fenêtre anti-rejeu, en secondes (recommandation Slack : 5 minutes). */
export const SLACK_MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

export type SlackSignatureFailureReason =
  | 'missing_signing_secret'
  | 'missing_signature_headers'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_signature';

export type SlackSignatureResult =
  | { valid: true }
  | { valid: false; reason: SlackSignatureFailureReason };

export interface VerifySlackSignatureInput {
  /** `SLACK_SIGNING_SECRET`. */
  signingSecret: string | undefined;
  /** En-tête `X-Slack-Request-Timestamp` (secondes epoch, en chaîne). */
  timestamp: string | undefined;
  /** En-tête `X-Slack-Signature` (`v0=<hex>`). */
  signature: string | undefined;
  /** Corps BRUT de la requête, tel que reçu (jamais re-sérialisé). */
  rawBody: string;
  /** Horloge injectable pour les tests. */
  nowMs?: number;
  /** Fenêtre anti-rejeu, en secondes. */
  maxSkewSeconds?: number;
}

/**
 * Calcule la signature attendue pour un corps brut donné.
 * Exposé pour permettre aux simulateurs / tests de forger une signature valide.
 */
export function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string
): string {
  const base = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const digest = createHmac('sha256', signingSecret).update(base, 'utf8').digest('hex');
  return `${SLACK_SIGNATURE_VERSION}=${digest}`;
}

export function verifySlackSignature(input: VerifySlackSignatureInput): SlackSignatureResult {
  const {
    signingSecret,
    timestamp,
    signature,
    rawBody,
    nowMs = Date.now(),
    maxSkewSeconds = SLACK_MAX_TIMESTAMP_SKEW_SECONDS,
  } = input;

  if (!signingSecret) {
    // Fail-closed : sans secret configuré on refuse tout, plutôt que d'ouvrir l'endpoint.
    return { valid: false, reason: 'missing_signing_secret' };
  }

  if (!timestamp || !signature) {
    return { valid: false, reason: 'missing_signature_headers' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || !/^-?\d+$/.test(timestamp.trim())) {
    return { valid: false, reason: 'invalid_timestamp' };
  }

  const skewSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (skewSeconds > maxSkewSeconds) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const expected = Buffer.from(computeSlackSignature(signingSecret, timestamp, rawBody), 'utf8');
  const received = Buffer.from(signature, 'utf8');

  // timingSafeEqual exige des buffers de même longueur : la longueur n'est pas un secret
  // (elle est fixe pour `v0=<64 hex>`), on peut donc court-circuiter sans risque.
  if (expected.length !== received.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (!timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
}
