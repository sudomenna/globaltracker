/**
 * Unit tests for the GA4 client_id 4-level cascade resolver.
 *
 * Covers:
 *   T-16-002A — resolveClientIdExtended (closure of OQ-012)
 *
 * The cascade priority is:
 *   1. self          — resolveClientId(input.user_data)
 *   2. sibling       — resolveClientId(input.sibling_user_data)
 *   3. cross_lead    — resolveClientId(input.cross_lead_user_data)
 *   4. deterministic — SHA-256(workspace_id:lead_id) → GA1.1.<8d>.<10d>
 *   5. unresolved    — null when lead_id is absent
 *
 * The resolver is pure: DB lookups are performed by the caller and the
 * already-fetched user_data records are passed in. crypto.subtle.digest is
 * provided by the Node 20+ runtime used by Vitest.
 *
 * BRs tested:
 *   BR-CONSENT-004: __fvid only set when consent_analytics=granted (upstream
 *                   gate; not enforced inside this resolver, but determinism
 *                   ensures stable cross-event continuity for opted-in leads).
 */

import { describe, expect, it } from 'vitest';

import {
  type ResolverInput,
  resolveClientIdExtended,
} from '../../../../apps/edge/src/dispatchers/ga4-mp/client-id-resolver.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_A = 'ws_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'ws_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LEAD_X = 'lead_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
const LEAD_Y = 'lead_yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy';

const FVID_36 = 'abcdef01-2345-6789-abcd-ef0123456789'; // 36 chars (UUID v4)
const FVID_SHORT = 'short12'; // 7 chars — needs zero pad
const GA_COOKIE_VALID = 'GA1.1.1234567890.1700000000';
const GA_CLIENT_ID_FROM_COOKIE = '1234567890.1700000000';

// Format the deterministic resolver always emits.
const DETERMINISTIC_FORMAT_REGEX = /^GA1\.1\.\d{8}\.\d{10}$/;

// Helper to build minimal ResolverInput overrides.
function makeInput(overrides: Partial<ResolverInput> = {}): ResolverInput {
  return {
    user_data: null,
    workspace_id: WORKSPACE_A,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Level 1 — self
// ---------------------------------------------------------------------------

describe('resolveClientIdExtended — Level 1 (self)', () => {
  it('returns client_id_ga4 verbatim when present in user_data; ignores sibling/cross_lead/lead_id', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: { client_id_ga4: 'GA1.1.111.222' },
        sibling_user_data: { client_id_ga4: 'GA1.1.999.999' },
        cross_lead_user_data: { client_id_ga4: 'GA1.1.888.888' },
        lead_id: LEAD_X,
      }),
    );

    expect(result).toEqual({
      client_id: 'GA1.1.111.222',
      source: 'self',
    });
  });

  it('extracts client_id from _ga cookie at self when client_id_ga4 absent', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: { _ga: GA_COOKIE_VALID },
      }),
    );

    expect(result).toEqual({
      client_id: GA_CLIENT_ID_FROM_COOKIE,
      source: 'self',
    });
  });

  it('mints client_id from fvid (UUID v4, 36 chars) at self when _ga absent', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: { fvid: FVID_36 },
      }),
    );

    // Format: GA1.1.<fvid[0..8]>.<fvid[8..18]>
    expect(result.source).toBe('self');
    expect(result.client_id).toBe(`GA1.1.${FVID_36.slice(0, 8)}.${FVID_36.slice(8, 18)}`);
  });
});

// ---------------------------------------------------------------------------
// Level 2 — sibling
// ---------------------------------------------------------------------------

describe('resolveClientIdExtended — Level 2 (sibling)', () => {
  it('falls back to sibling_user_data when self user_data has no resolvable signal', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: { client_id_ga4: null, _ga: null, fvid: null },
        sibling_user_data: { _ga: GA_COOKIE_VALID },
        cross_lead_user_data: { fvid: FVID_36 },
        lead_id: LEAD_X,
      }),
    );

    expect(result).toEqual({
      client_id: GA_CLIENT_ID_FROM_COOKIE,
      source: 'sibling',
    });
  });

  it('skips sibling when sibling_user_data is empty and proceeds to cross_lead', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: null,
        sibling_user_data: null,
        cross_lead_user_data: { fvid: FVID_36 },
        lead_id: LEAD_X,
      }),
    );

    expect(result.source).toBe('cross_lead');
    expect(result.client_id).toBe(`GA1.1.${FVID_36.slice(0, 8)}.${FVID_36.slice(8, 18)}`);
  });
});

// ---------------------------------------------------------------------------
// Level 3 — cross_lead
// ---------------------------------------------------------------------------

describe('resolveClientIdExtended — Level 3 (cross_lead)', () => {
  it('falls back to cross_lead_user_data when self and sibling are both empty (uses _ga)', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: null,
        sibling_user_data: null,
        cross_lead_user_data: { _ga: GA_COOKIE_VALID },
        lead_id: LEAD_X,
      }),
    );

    expect(result).toEqual({
      client_id: GA_CLIENT_ID_FROM_COOKIE,
      source: 'cross_lead',
    });
  });

  it('mints client_id from fvid in cross_lead_user_data when _ga absent there', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: null,
        sibling_user_data: null,
        cross_lead_user_data: { fvid: FVID_36 },
        lead_id: LEAD_X,
      }),
    );

    expect(result.source).toBe('cross_lead');
    expect(result.client_id).toBe(`GA1.1.${FVID_36.slice(0, 8)}.${FVID_36.slice(8, 18)}`);
  });

  it('handles short fvid in cross_lead by right-padding with zeros (covers pad behavior)', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: null,
        sibling_user_data: null,
        cross_lead_user_data: { fvid: FVID_SHORT },
        lead_id: LEAD_X,
      }),
    );

    // 'short12' (7 chars) padded to 18 with zeros → 'short12' + '00000000000'
    // segment1 = 'short12' + '0' (8 chars), segment2 = '0000000000' (10 chars)
    const padded = FVID_SHORT.padEnd(18, '0');
    expect(result.source).toBe('cross_lead');
    expect(result.client_id).toBe(`GA1.1.${padded.slice(0, 8)}.${padded.slice(8, 18)}`);
  });
});

// ---------------------------------------------------------------------------
// Level 4 — deterministic
// ---------------------------------------------------------------------------

describe('resolveClientIdExtended — Level 4 (deterministic fallback)', () => {
  it('mints deterministic client_id when all user_datas empty but lead_id + workspace_id present', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: null,
        sibling_user_data: null,
        cross_lead_user_data: null,
        lead_id: LEAD_X,
        workspace_id: WORKSPACE_A,
      }),
    );

    expect(result.source).toBe('deterministic');
    expect(result.client_id).not.toBeNull();
    expect(result.client_id).toMatch(DETERMINISTIC_FORMAT_REGEX);
  });

  it('handles all-null user_datas (not just empty objects) and falls into deterministic', async () => {
    const result = await resolveClientIdExtended({
      user_data: null,
      sibling_user_data: null,
      cross_lead_user_data: null,
      lead_id: LEAD_X,
      workspace_id: WORKSPACE_A,
    });

    expect(result.source).toBe('deterministic');
    expect(result.client_id).toMatch(DETERMINISTIC_FORMAT_REGEX);
  });

  it('determinism: identical (workspace_id, lead_id) produce identical client_id across calls', async () => {
    const a = await resolveClientIdExtended(
      makeInput({ workspace_id: WORKSPACE_A, lead_id: LEAD_X }),
    );
    const b = await resolveClientIdExtended(
      makeInput({ workspace_id: WORKSPACE_A, lead_id: LEAD_X }),
    );

    expect(a.source).toBe('deterministic');
    expect(b.source).toBe('deterministic');
    expect(a.client_id).toBe(b.client_id);
  });

  it('workspace isolation: same lead_id under different workspace_id yields different client_ids', async () => {
    const a = await resolveClientIdExtended(
      makeInput({ workspace_id: WORKSPACE_A, lead_id: LEAD_X }),
    );
    const b = await resolveClientIdExtended(
      makeInput({ workspace_id: WORKSPACE_B, lead_id: LEAD_X }),
    );

    expect(a.client_id).not.toBeNull();
    expect(b.client_id).not.toBeNull();
    expect(a.client_id).not.toBe(b.client_id);
  });

  it('lead isolation: same workspace_id with different lead_ids yields different client_ids', async () => {
    const a = await resolveClientIdExtended(
      makeInput({ workspace_id: WORKSPACE_A, lead_id: LEAD_X }),
    );
    const b = await resolveClientIdExtended(
      makeInput({ workspace_id: WORKSPACE_A, lead_id: LEAD_Y }),
    );

    expect(a.client_id).not.toBeNull();
    expect(b.client_id).not.toBeNull();
    expect(a.client_id).not.toBe(b.client_id);
  });
});

// ---------------------------------------------------------------------------
// Level 5 — unresolved
// ---------------------------------------------------------------------------

describe('resolveClientIdExtended — Level 5 (unresolved)', () => {
  it('returns { client_id: null, source: "unresolved" } when all user_datas empty AND lead_id is undefined', async () => {
    const result = await resolveClientIdExtended({
      user_data: null,
      sibling_user_data: null,
      cross_lead_user_data: null,
      workspace_id: WORKSPACE_A,
      // lead_id intentionally absent
    });

    expect(result).toEqual({ client_id: null, source: 'unresolved' });
  });

  it('returns unresolved when lead_id is explicitly null', async () => {
    const result = await resolveClientIdExtended(
      makeInput({
        user_data: null,
        sibling_user_data: null,
        cross_lead_user_data: null,
        lead_id: null,
      }),
    );

    expect(result).toEqual({ client_id: null, source: 'unresolved' });
  });
});
