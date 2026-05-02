/**
 * Unit tests for apps/edge/src/lib/lead-token.ts
 *
 * Covers:
 *   BR-IDENTITY-005: HMAC token has mandatory binding to page_token_hash
 *     (structural verification of token format + timing-safe compare)
 *   INV-IDENTITY-006: LeadToken valid only with matching page_token_hash claim
 *     (parse returns payload for DB lookup; verification is separate step)
 *
 * Target coverage: ≥ 95%
 */

import { describe, expect, it } from 'vitest';
import {
  type LeadTokenPayload,
  generateLeadToken,
  parseLeadToken,
  verifyLeadToken,
} from '../../../apps/edge/src/lib/lead-token';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 32-byte HMAC secret — test-only. */
function makeSecret(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const SECRET_A = makeSecret(0xaa);
const SECRET_B = makeSecret(0xbb);

const LEAD_ID = 'lead_01HV0000000000000000000000';
const WORKSPACE_ID = 'ws_01HV0000000000000000000000';

const FIXED_NOW_SEC = 1_700_000_000;

// ---------------------------------------------------------------------------
// generateLeadToken
// ---------------------------------------------------------------------------

describe('generateLeadToken', () => {
  it('returns ok with a non-empty token string', async () => {
    const result = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value).toBe('string');
    expect(result.value.length).toBeGreaterThan(0);
  });

  it('token contains exactly one dot separator', async () => {
    const result = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dotCount = (result.value.match(/\./g) ?? []).length;
    expect(dotCount).toBe(1);
  });

  it('produces a URL-safe token (no +, /, or = characters)', async () => {
    const result = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/[+/=]/);
  });

  it('two calls with same inputs produce different tokens (timestamp)', async () => {
    // Use different timestamps to guarantee uniqueness
    const r1 = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    const r2 = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC + 1,
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value).not.toBe(r2.value);
  });

  it('different secrets produce different tokens', async () => {
    const r1 = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    const r2 = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_B,
      FIXED_NOW_SEC,
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value).not.toBe(r2.value);
  });

  it('different leadIds produce different tokens', async () => {
    const r1 = await generateLeadToken(
      'lead_A',
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    const r2 = await generateLeadToken(
      'lead_B',
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value).not.toBe(r2.value);
  });

  it('different workspaceIds produce different tokens', async () => {
    const r1 = await generateLeadToken(
      LEAD_ID,
      'ws_AAA',
      SECRET_A,
      FIXED_NOW_SEC,
    );
    const r2 = await generateLeadToken(
      LEAD_ID,
      'ws_BBB',
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value).not.toBe(r2.value);
  });

  it('uses current time when nowSec is not provided', async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await generateLeadToken(LEAD_ID, WORKSPACE_ID, SECRET_A);
    const after = Math.floor(Date.now() / 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseLeadToken(result.value);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.issuedAt).toBeGreaterThanOrEqual(before);
    expect(parsed.issuedAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// parseLeadToken
// ---------------------------------------------------------------------------

describe('parseLeadToken', () => {
  it('returns LeadTokenPayload with correct fields for a valid token', async () => {
    const gen = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const parsed = parseLeadToken(gen.value);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.leadId).toBe(LEAD_ID);
    expect(parsed.workspaceId).toBe(WORKSPACE_ID);
    expect(parsed.issuedAt).toBe(FIXED_NOW_SEC);
  });

  it('INV-IDENTITY-006: returns payload without verifying signature', async () => {
    // Tamper with the signature part — parseLeadToken should still decode payload
    const gen = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const parts = gen.value.split('.');
    const tamperedToken = `${parts[0]}.INVALIDSIG`;
    const parsed = parseLeadToken(tamperedToken);
    // parseLeadToken decodes the payload regardless of signature validity
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.leadId).toBe(LEAD_ID);
  });

  it('returns null for an empty string', () => {
    expect(parseLeadToken('')).toBeNull();
  });

  it('returns null for a token with no dot', () => {
    expect(parseLeadToken('nodothere')).toBeNull();
  });

  it('returns null for a token with invalid base64url payload', () => {
    expect(parseLeadToken('!!!invalid!!!.sig')).toBeNull();
  });

  it('returns null for null input', () => {
    // @ts-expect-error — testing runtime safety with wrong type
    expect(parseLeadToken(null)).toBeNull();
  });

  it('returns null for a payload with fewer than 3 colon-separated parts', () => {
    // Encode a payload with only 2 parts
    const twoPartPayload = btoa('only:two')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    expect(parseLeadToken(`${twoPartPayload}.sig`)).toBeNull();
  });

  it('returns null for a payload with non-numeric issuedAt', () => {
    const badTs = btoa('ws:lead:notanumber')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    expect(parseLeadToken(`${badTs}.sig`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyLeadToken
// ---------------------------------------------------------------------------

describe('verifyLeadToken', () => {
  it('BR-IDENTITY-005: returns true for a valid token with matching claims', async () => {
    const gen = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const valid = await verifyLeadToken(
      gen.value,
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
    );
    expect(valid).toBe(true);
  });

  it('BR-IDENTITY-005: returns false for a tampered signature', async () => {
    const gen = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const parts = gen.value.split('.');
    const tampered = `${parts[0]}.AAAAaaaa`;
    const valid = await verifyLeadToken(
      tampered,
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
    );
    expect(valid).toBe(false);
  });

  it('BR-IDENTITY-005: returns false when wrong secret is used', async () => {
    const gen = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const valid = await verifyLeadToken(
      gen.value,
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_B,
    );
    expect(valid).toBe(false);
  });

  it('returns false when leadId in token does not match supplied leadId', async () => {
    const gen = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const valid = await verifyLeadToken(
      gen.value,
      'lead_OTHER',
      WORKSPACE_ID,
      SECRET_A,
    );
    expect(valid).toBe(false);
  });

  it('returns false when workspaceId in token does not match supplied workspaceId', async () => {
    const gen = await generateLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;

    const valid = await verifyLeadToken(
      gen.value,
      LEAD_ID,
      'ws_OTHER',
      SECRET_A,
    );
    expect(valid).toBe(false);
  });

  it('returns false for an empty token', async () => {
    const valid = await verifyLeadToken('', LEAD_ID, WORKSPACE_ID, SECRET_A);
    expect(valid).toBe(false);
  });

  it('returns false for a token with no dot separator', async () => {
    const valid = await verifyLeadToken(
      'justsomegibberish',
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
    );
    expect(valid).toBe(false);
  });

  it('returns false for a completely random string', async () => {
    const valid = await verifyLeadToken(
      'abc.def',
      LEAD_ID,
      WORKSPACE_ID,
      SECRET_A,
    );
    expect(valid).toBe(false);
  });

  it('BR-IDENTITY-005: token from workspace A cannot verify against workspace B', async () => {
    // INV-IDENTITY-006: tokens are scoped to workspace
    const genA = await generateLeadToken(
      LEAD_ID,
      'ws_AAA',
      SECRET_A,
      FIXED_NOW_SEC,
    );
    expect(genA.ok).toBe(true);
    if (!genA.ok) return;

    const valid = await verifyLeadToken(
      genA.value,
      LEAD_ID,
      'ws_BBB',
      SECRET_A,
    );
    expect(valid).toBe(false);
  });

  it('round-trip: generate then verify is always true', async () => {
    for (let i = 0; i < 5; i++) {
      const gen = await generateLeadToken(
        LEAD_ID,
        WORKSPACE_ID,
        SECRET_A,
        FIXED_NOW_SEC + i,
      );
      expect(gen.ok).toBe(true);
      if (!gen.ok) continue;
      const valid = await verifyLeadToken(
        gen.value,
        LEAD_ID,
        WORKSPACE_ID,
        SECRET_A,
      );
      expect(valid).toBe(true);
    }
  });
});
