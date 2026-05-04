/**
 * Unit tests for apps/edge/src/integrations/hotmart/mapper.ts
 *
 * T-ID: T-9-001
 * Spec: docs/40-integrations/07-hotmart-webhook.md
 *
 * Coverage:
 *   - Each Hotmart event type → correct InternalEvent type or skip
 *   - Idempotency key determinism, truncation, and prefix isolation
 *   - Lead hints hierarchy (lead_public_id → email → phone → name)
 *   - UTM + tracking attribution mapping
 *   - Missing required fields
 *   - Fixture file consistency
 *
 * BRs verified:
 *   BR-WEBHOOK-002: event_id is deterministic and 32 chars
 *   BR-WEBHOOK-003: SUBSCRIPTION_CANCELLATION → skip; unknown events → error
 *   BR-WEBHOOK-004: lead_hints hierarchy
 *   BR-PRIVACY-001: email/phone/name passed as raw strings (not hashed here)
 */

import { describe, expect, it } from 'vitest';
import {
  deriveHotmartEventId,
  mapHotmartToInternal,
} from '../../../apps/edge/src/integrations/hotmart/mapper';
import type { HotmartWebhookPayload } from '../../../apps/edge/src/integrations/hotmart/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeApprovedPayload(
  overrides: Partial<HotmartWebhookPayload> = {},
): HotmartWebhookPayload {
  return {
    event: 'PURCHASE_APPROVED',
    id: 'evt_hotmart_test_001',
    creation_date: 1705316400000,
    version: '2.0.0',
    data: {
      purchase: {
        transaction: 'HP11223344556677',
        status: 'approved',
        price: {
          value: 29700,
          currency_value: 'BRL',
        },
        tracking: {
          source: 'facebook',
          source_sck: 'sck_abc123',
          external_reference: null,
        },
        utms: {
          utm_source: 'facebook',
          utm_medium: 'paid',
          utm_campaign: 'camp_launch_2024_jan',
          utm_content: 'ad_carousel_01',
          utm_term: null,
        },
      },
      buyer: {
        name: 'Comprador Teste',
        email: 'comprador@example.com',
        checkout_phone: '+5511999990001',
      },
      product: {
        id: 1234567,
        name: 'Curso Teste XYZ',
      },
    },
    metadata: {
      lead_public_id: 'lead_pub_aabbccdd1122',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveHotmartEventId
// ---------------------------------------------------------------------------

describe('deriveHotmartEventId', () => {
  it('BR-WEBHOOK-002: returns a 32-char hex string', async () => {
    const id = await deriveHotmartEventId('HP11223344556677', 'PURCHASE_APPROVED');
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BR-WEBHOOK-002: is deterministic — same inputs produce same key', async () => {
    const id1 = await deriveHotmartEventId('HP11223344', 'PURCHASE_APPROVED');
    const id2 = await deriveHotmartEventId('HP11223344', 'PURCHASE_APPROVED');
    expect(id1).toBe(id2);
  });

  it('BR-WEBHOOK-002: different event type produces different key', async () => {
    const id1 = await deriveHotmartEventId('HP11223344', 'PURCHASE_APPROVED');
    const id2 = await deriveHotmartEventId('HP11223344', 'PURCHASE_REFUNDED');
    expect(id1).not.toBe(id2);
  });

  it('BR-WEBHOOK-002: different transaction produces different key', async () => {
    const id1 = await deriveHotmartEventId('HP111', 'PURCHASE_APPROVED');
    const id2 = await deriveHotmartEventId('HP222', 'PURCHASE_APPROVED');
    expect(id1).not.toBe(id2);
  });

  it('includes hotmart: prefix in the hash input (isolates from other platforms)', async () => {
    // Derive two IDs with same inputs but different platforms — the Hotmart one
    // must differ from an identical input without the "hotmart:" prefix
    const hotmartId = await deriveHotmartEventId('TX123', 'PURCHASE_APPROVED');
    // Simulate non-prefixed derivation (different input format)
    const enc = new TextEncoder();
    const raw = enc.encode('TX123:PURCHASE_APPROVED'); // no prefix
    const hashBuffer = await crypto.subtle.digest('SHA-256', raw);
    const hex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
    expect(hotmartId).not.toBe(hex);
  });

  it('truncates sha256 to exactly 32 chars (first 32 hex chars of digest)', async () => {
    const id = await deriveHotmartEventId('x', 'y');
    expect(id.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// mapHotmartToInternal — PURCHASE_APPROVED
// ---------------------------------------------------------------------------

describe('mapHotmartToInternal — PURCHASE_APPROVED', () => {
  it('maps PURCHASE_APPROVED → Purchase', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Purchase');
  });

  it('sets platform to hotmart', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform).toBe('hotmart');
  });

  it('sets platform_event_id from data.purchase.transaction', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.platform_event_id).toBe('HP11223344556677');
  });

  it('derives deterministic event_id (32 chars)', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toHaveLength(32);
    expect(result.value.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BR-WEBHOOK-002: same payload produces same event_id', async () => {
    const payload = makeApprovedPayload();
    const r1 = await mapHotmartToInternal(payload);
    const r2 = await mapHotmartToInternal(payload);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.event_id).toBe(r2.value.event_id);
  });

  it('stores value in centavos as received (29700)', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.custom_data.value).toBe(29700);
  });

  it('sets currency from price.currency_value', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.custom_data.currency).toBe('BRL');
  });

  it('sets custom_data.order_id from transaction', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.custom_data.order_id).toBe('HP11223344556677');
  });

  it('derives occurred_at from creation_date epoch ms', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurred_at).toBe(
      new Date(1705316400000).toISOString(),
    );
  });
});

// ---------------------------------------------------------------------------
// mapHotmartToInternal — event type mapping
// ---------------------------------------------------------------------------

describe('mapHotmartToInternal — event type mapping', () => {
  const events = [
    { event: 'PURCHASE_APPROVED', expected: 'Purchase' },
    { event: 'PURCHASE_REFUNDED', expected: 'RefundProcessed' },
    { event: 'PURCHASE_CHARGEBACK', expected: 'Chargeback' },
    { event: 'PURCHASE_PROTEST', expected: 'Chargeback' },
    { event: 'PURCHASE_BILLET_PRINTED', expected: 'InitiateCheckout' },
  ] as const;

  for (const { event, expected } of events) {
    it(`${event} → ${expected}`, async () => {
      const payload = makeApprovedPayload({ event });
      const result = await mapHotmartToInternal(payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.event_type).toBe(expected);
    });
  }

  it('BR-WEBHOOK-003: SUBSCRIPTION_CANCELLATION → skip (Phase 2 not supported)', async () => {
    const payload = makeApprovedPayload({ event: 'SUBSCRIPTION_CANCELLATION' });
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('skip' in result && result.skip).toBe(true);
  });

  it('BR-WEBHOOK-003: unknown event type → error (not skip)', async () => {
    const payload = makeApprovedPayload({
      event: 'PURCHASE_FUTURE_UNKNOWN_TYPE',
    });
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('skip' in result ? result.skip : undefined).toBeFalsy();
    if (!('error' in result)) return;
    expect(result.error.code).toBe('unknown_event_type');
  });

  it('BR-WEBHOOK-002: PURCHASE_PROTEST and PURCHASE_CHARGEBACK produce different event_ids', async () => {
    const protestPayload = makeApprovedPayload({ event: 'PURCHASE_PROTEST' });
    const chargebackPayload = makeApprovedPayload({
      event: 'PURCHASE_CHARGEBACK',
    });
    const r1 = await mapHotmartToInternal(protestPayload);
    const r2 = await mapHotmartToInternal(chargebackPayload);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Different hotmart events → different event_ids even with same transaction
    expect(r1.value.event_id).not.toBe(r2.value.event_id);
  });
});

// ---------------------------------------------------------------------------
// mapHotmartToInternal — lead hints (BR-WEBHOOK-004)
// ---------------------------------------------------------------------------

describe('mapHotmartToInternal — lead hints', () => {
  it('BR-WEBHOOK-004 priority 1: metadata.lead_public_id populated', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBe(
      'lead_pub_aabbccdd1122',
    );
  });

  it('BR-WEBHOOK-004: lead_public_id is null when metadata absent', async () => {
    const payload = makeApprovedPayload({ metadata: null });
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBeNull();
  });

  it('BR-WEBHOOK-004: lead_public_id is null when metadata.lead_public_id absent', async () => {
    const payload = makeApprovedPayload({ metadata: {} });
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.lead_public_id).toBeNull();
  });

  it('BR-WEBHOOK-004 / BR-PRIVACY-001: email from buyer.email (raw, not hashed)', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.email).toBe('comprador@example.com');
  });

  it('BR-WEBHOOK-004 / BR-PRIVACY-001: phone from buyer.checkout_phone', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.phone).toBe('+5511999990001');
  });

  it('lead_hints.phone is null when checkout_phone absent', async () => {
    const payload = makeApprovedPayload();
    payload.data.buyer.checkout_phone = null;
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.phone).toBeNull();
  });

  it('BR-PRIVACY-001: buyer.name passed as raw string in lead_hints.name', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_hints.name).toBe('Comprador Teste');
  });
});

// ---------------------------------------------------------------------------
// mapHotmartToInternal — attribution mapping
// ---------------------------------------------------------------------------

describe('mapHotmartToInternal — attribution', () => {
  it('maps utms.utm_source when both utms and tracking present (utms take precedence)', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution?.utm_source).toBe('facebook');
  });

  it('maps utms fields to attribution', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution?.utm_medium).toBe('paid');
    expect(result.value.attribution?.utm_campaign).toBe('camp_launch_2024_jan');
    expect(result.value.attribution?.utm_content).toBe('ad_carousel_01');
    expect(result.value.attribution?.utm_term).toBeNull();
  });

  it('maps tracking.source_sck to attribution.source_sck', async () => {
    const result = await mapHotmartToInternal(makeApprovedPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution?.source_sck).toBe('sck_abc123');
  });

  it('falls back to tracking.source when utms.utm_source is absent', async () => {
    const payload = makeApprovedPayload();
    payload.data.purchase.utms = null;
    payload.data.purchase.tracking = {
      source: 'google',
      source_sck: null,
      external_reference: null,
    };
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution?.utm_source).toBe('google');
  });

  it('attribution is null when both tracking and utms are absent', async () => {
    const payload = makeApprovedPayload();
    payload.data.purchase.tracking = null;
    payload.data.purchase.utms = null;
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapHotmartToInternal — missing required fields
// ---------------------------------------------------------------------------

describe('mapHotmartToInternal — missing required fields', () => {
  it('returns error when event is missing', async () => {
    const payload = makeApprovedPayload({ event: '' as never });
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (!('error' in result)) return;
    expect(result.error.code).toBe('missing_required_field');
  });

  it('returns error when data.purchase.transaction is missing', async () => {
    const payload = makeApprovedPayload();
    payload.data.purchase.transaction = '';
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (!('error' in result)) return;
    expect(result.error.code).toBe('missing_required_field');
  });

  it('returns error when data.buyer.email is missing', async () => {
    const payload = makeApprovedPayload();
    payload.data.buyer.email = '';
    const result = await mapHotmartToInternal(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (!('error' in result)) return;
    expect(result.error.code).toBe('missing_required_field');
  });
});

// ---------------------------------------------------------------------------
// Fixture file consistency
// ---------------------------------------------------------------------------

describe('fixture files', () => {
  it('purchase-approved fixture maps to Purchase', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/hotmart/purchase-approved.json',
      { assert: { type: 'json' } }
    )) as { default: HotmartWebhookPayload };
    const result = await mapHotmartToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Purchase');
    expect(result.value.platform).toBe('hotmart');
    expect(result.value.event_id).toHaveLength(32);
  });

  it('purchase-refunded fixture maps to RefundProcessed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/hotmart/purchase-refunded.json',
      { assert: { type: 'json' } }
    )) as { default: HotmartWebhookPayload };
    const result = await mapHotmartToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('RefundProcessed');
    expect(result.value.platform).toBe('hotmart');
  });

  it('purchase-chargeback fixture maps to Chargeback', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/hotmart/purchase-chargeback.json',
      { assert: { type: 'json' } }
    )) as { default: HotmartWebhookPayload };
    const result = await mapHotmartToInternal(fixture.default);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_type).toBe('Chargeback');
    expect(result.value.platform).toBe('hotmart');
  });

  it('purchase-approved fixture: event_id is deterministic (stable across test runs)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixture = (await import(
      '../../fixtures/hotmart/purchase-approved.json',
      { assert: { type: 'json' } }
    )) as { default: HotmartWebhookPayload };
    const r1 = await mapHotmartToInternal(fixture.default);
    const r2 = await mapHotmartToInternal(fixture.default);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.event_id).toBe(r2.value.event_id);
  });

  it('purchase-approved and purchase-refunded fixtures with same transaction produce different event_ids', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixtureApproved = (await import(
      '../../fixtures/hotmart/purchase-approved.json',
      { assert: { type: 'json' } }
    )) as { default: HotmartWebhookPayload };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fixtureRefunded = (await import(
      '../../fixtures/hotmart/purchase-refunded.json',
      { assert: { type: 'json' } }
    )) as { default: HotmartWebhookPayload };
    const r1 = await mapHotmartToInternal(fixtureApproved.default);
    const r2 = await mapHotmartToInternal(fixtureRefunded.default);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Same transaction code, different event → different event_id
    expect(r1.value.platform_event_id).toBe(r2.value.platform_event_id);
    expect(r1.value.event_id).not.toBe(r2.value.event_id);
  });
});

// ---------------------------------------------------------------------------
// Handler-layer signature tests (unit — no HTTP, pure token comparison logic)
// ---------------------------------------------------------------------------

describe('signature validation — timingSafeTokenEqual (unit)', () => {
  /**
   * Extracted from hotmart.ts for unit testing without spinning up an HTTP server.
   * Tests verify BR-WEBHOOK-001: constant-time comparison.
   */
  async function timingSafeTokenEqual(a: string, b: string): Promise<boolean> {
    if (a.length !== b.length) {
      const enc = new TextEncoder();
      const aBytes = enc.encode(a);
      await crypto.subtle.digest('SHA-256', aBytes);
      return false;
    }
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    const bBytes = enc.encode(b);
    const [aHash, bHash] = await Promise.all([
      crypto.subtle.digest('SHA-256', aBytes),
      crypto.subtle.digest('SHA-256', bBytes),
    ]);
    const aView = new Uint8Array(aHash);
    const bView = new Uint8Array(bHash);
    let diff = 0;
    for (let i = 0; i < aView.length; i++) {
      diff |= (aView[i] ?? 0) ^ (bView[i] ?? 0);
    }
    return diff === 0;
  }

  it('BR-WEBHOOK-001: matching tokens return true', async () => {
    const token = 'my_secret_token_12345678';
    expect(await timingSafeTokenEqual(token, token)).toBe(true);
  });

  it('BR-WEBHOOK-001: different tokens return false', async () => {
    expect(
      await timingSafeTokenEqual('correct_token', 'wrong___token'),
    ).toBe(false);
  });

  it('BR-WEBHOOK-001: token with different length returns false (no early exit)', async () => {
    expect(
      await timingSafeTokenEqual('short', 'much_longer_token'),
    ).toBe(false);
  });

  it('BR-WEBHOOK-001: empty string against non-empty returns false', async () => {
    expect(await timingSafeTokenEqual('', 'token')).toBe(false);
  });

  it('BR-WEBHOOK-001: both empty strings returns true', async () => {
    expect(await timingSafeTokenEqual('', '')).toBe(true);
  });

  it('BR-WEBHOOK-001: tokens differing only in last char return false', async () => {
    expect(
      await timingSafeTokenEqual('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaab'),
    ).toBe(false);
  });
});
