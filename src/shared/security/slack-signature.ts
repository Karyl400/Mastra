import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_SIGNATURE_VERSION = 'v0';

export const SLACK_MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

export type SlackSignatureFailureReason =
  | 'missing_signing_secret'
  | 'missing_signature_headers'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_signature';

export type SlackSignatureResult =
  { valid: true } | { valid: false; reason: SlackSignatureFailureReason };

export interface VerifySlackSignatureInput {
  signingSecret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs?: number;
  maxSkewSeconds?: number;
}

export function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
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

  if (expected.length !== received.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (!timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
}
