import { describe, it, expect } from 'vitest';
import {
  computeSlackSignature,
  verifySlackSignature,
  SLACK_MAX_TIMESTAMP_SKEW_SECONDS,
} from '../../../src/shared/security/slack-signature';

const SECRET = 'test-signing-secret';
const RAW_BODY = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });

describe('Slack signature verification', () => {
  it('accepts a signature computed over v0:{timestamp}:{rawBody}', () => {
    const nowMs = 1_700_000_000_000;
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = computeSlackSignature(SECRET, timestamp, RAW_BODY);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp,
      signature,
      rawBody: RAW_BODY,
      nowMs,
    });

    expect(result).toEqual({ valid: true });
    expect(signature).toMatch(/^v0=[a-f0-9]{64}$/);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const nowMs = 1_700_000_000_000;
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = computeSlackSignature(SECRET, timestamp, RAW_BODY);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp,
      signature,
      rawBody: `${RAW_BODY} `,
      nowMs,
    });

    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects a signature forged with the wrong secret', () => {
    const nowMs = 1_700_000_000_000;
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = computeSlackSignature('wrong-secret', timestamp, RAW_BODY);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp,
      signature,
      rawBody: RAW_BODY,
      nowMs,
    });

    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects a signature of the wrong length without throwing (timingSafeEqual guard)', () => {
    const nowMs = 1_700_000_000_000;
    const timestamp = String(Math.floor(nowMs / 1000));

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp,
      signature: 'v0=deadbeef',
      rawBody: RAW_BODY,
      nowMs,
    });

    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects a timestamp older than 5 minutes (replay protection)', () => {
    const nowMs = 1_700_000_000_000;
    const staleTimestamp = String(
      Math.floor(nowMs / 1000) - (SLACK_MAX_TIMESTAMP_SKEW_SECONDS + 1),
    );
    const signature = computeSlackSignature(SECRET, staleTimestamp, RAW_BODY);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp: staleTimestamp,
      signature,
      rawBody: RAW_BODY,
      nowMs,
    });

    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('accepts a timestamp just inside the 5 minute window', () => {
    const nowMs = 1_700_000_000_000;
    const timestamp = String(Math.floor(nowMs / 1000) - (SLACK_MAX_TIMESTAMP_SKEW_SECONDS - 1));
    const signature = computeSlackSignature(SECRET, timestamp, RAW_BODY);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp,
      signature,
      rawBody: RAW_BODY,
      nowMs,
    });

    expect(result).toEqual({ valid: true });
  });

  it('rejects a timestamp too far in the FUTURE (clock-skew abuse)', () => {
    const nowMs = 1_700_000_000_000;
    const timestamp = String(Math.floor(nowMs / 1000) + SLACK_MAX_TIMESTAMP_SKEW_SECONDS + 60);
    const signature = computeSlackSignature(SECRET, timestamp, RAW_BODY);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp,
      signature,
      rawBody: RAW_BODY,
      nowMs,
    });

    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('rejects a non-numeric timestamp', () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestamp: 'not-a-number',
      signature: `v0=${'0'.repeat(64)}`,
      rawBody: RAW_BODY,
    });

    expect(result).toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('rejects when signature headers are missing', () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: undefined,
        signature: `v0=${'0'.repeat(64)}`,
        rawBody: RAW_BODY,
      }),
    ).toEqual({ valid: false, reason: 'missing_signature_headers' });

    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: '1700000000',
        signature: undefined,
        rawBody: RAW_BODY,
      }),
    ).toEqual({ valid: false, reason: 'missing_signature_headers' });
  });

  it('fails closed when SLACK_SIGNING_SECRET is not configured', () => {
    const result = verifySlackSignature({
      signingSecret: undefined,
      timestamp: '1700000000',
      signature: `v0=${'0'.repeat(64)}`,
      rawBody: RAW_BODY,
    });

    expect(result).toEqual({ valid: false, reason: 'missing_signing_secret' });
  });
});
