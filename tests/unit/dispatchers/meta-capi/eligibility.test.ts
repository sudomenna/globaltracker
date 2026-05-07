/**
 * Unit tests for Meta CAPI eligibility — visitor_id como 5º sinal de identidade.
 *
 * T-16-001D — cobre as mudanças da Onda 1 (T-16-001A/B/C):
 *   - visitor_id (cookie __fvid, UUID v4) conta como sinal válido junto com
 *     em, ph, fbc, fbp.
 *   - Habilita PageView anônimo a ser dispatchado quando só há __fvid.
 *   - visitor_id NÃO bypassa consent denied explícito.
 *   - visitor_id NÃO bypassa pixel_id ausente.
 *   - email_hash sozinho continua sendo sinal válido (sem regressão).
 *
 * BRs cobertas:
 *   BR-CONSENT-003: ad_user_data='granted' obrigatório, mesmo com visitor_id.
 *   BR-DISPATCH-004: skip_reason mandatório quando ineligible; ordem fail-fast
 *                    pixel_id → consent → identity signal.
 */

import { describe, expect, it } from 'vitest';

import {
  type EligibilityEvent,
  type EligibilityLead,
  type MetaLaunchConfig,
  checkEligibility,
} from '../../../../apps/edge/src/dispatchers/meta-capi/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VISITOR_UUID = 'abc-uuid-123';
const PIXEL_ID = 'pixel-123';

function makeLaunchConfig(pixelId: string | null = PIXEL_ID): MetaLaunchConfig {
  return { tracking: { meta: { pixel_id: pixelId } } };
}

function makeEvent(overrides: Partial<EligibilityEvent> = {}): EligibilityEvent {
  return {
    consent_snapshot: { ad_user_data: 'granted' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cenário 1 — PageView anônimo com só visitor_id é elegível
// ---------------------------------------------------------------------------

describe('checkEligibility — visitor_id habilita dispatch anônimo', () => {
  it('eligible quando só há visitor_id (sem fbc/fbp, lead null, consent OK, pixel configurado)', () => {
    const event = makeEvent({
      visitor_id: VISITOR_UUID,
      // sem user_data (sem fbc/fbp)
    });

    const result = checkEligibility(event, null, makeLaunchConfig());

    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cenário 2 — sem nenhum dos 5 sinais cai em no_user_data
// ---------------------------------------------------------------------------

describe('checkEligibility — no_user_data quando nenhum sinal presente', () => {
  it('not eligible quando event sem visitor_id/fbc/fbp + lead null + consent OK + pixel OK — reason: no_user_data', () => {
    const event = makeEvent({
      // sem visitor_id, sem user_data
    });

    const result = checkEligibility(event, null, makeLaunchConfig());

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_user_data');
  });

  it('not eligible quando event tem user_data vazio + lead com hashes nulos + consent OK — reason: no_user_data', () => {
    const event = makeEvent({
      visitor_id: null,
      user_data: { fbc: null, fbp: null },
    });
    const lead: EligibilityLead = { email_hash: null, phone_hash: null };

    const result = checkEligibility(event, lead, makeLaunchConfig());

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_user_data');
  });
});

// ---------------------------------------------------------------------------
// Cenário 3 — visitor_id não bypassa consent denied
// ---------------------------------------------------------------------------

describe('checkEligibility — visitor_id NÃO bypassa consent', () => {
  it('not eligible quando visitor_id presente mas ad_user_data=denied — reason: consent_denied:ad_user_data', () => {
    const event = makeEvent({
      visitor_id: VISITOR_UUID,
      consent_snapshot: { ad_user_data: 'denied' },
    });

    const result = checkEligibility(event, null, makeLaunchConfig());

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    // BR-CONSENT-003: consent denied explícito sempre manda, mesmo com visitor_id.
    // Tiago pediu permissivo, mas denied bloqueia.
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('not eligible quando visitor_id presente mas ad_user_data=unknown — reason: consent_denied:ad_user_data', () => {
    const event = makeEvent({
      visitor_id: VISITOR_UUID,
      consent_snapshot: { ad_user_data: 'unknown' },
    });

    const result = checkEligibility(event, null, makeLaunchConfig());

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });
});

// ---------------------------------------------------------------------------
// Cenário 4 — visitor_id não bypassa pixel_id ausente
// ---------------------------------------------------------------------------

describe('checkEligibility — visitor_id NÃO bypassa pixel_id ausente', () => {
  it('not eligible quando visitor_id presente mas pixel_id ausente — reason: integration_not_configured', () => {
    const event = makeEvent({
      visitor_id: VISITOR_UUID,
    });

    const result = checkEligibility(event, null, makeLaunchConfig(null));

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    // BR-DISPATCH-004: pixel_id é check #1 (fail-fast); visitor_id não muda isso.
    expect(result.reason).toBe('integration_not_configured');
  });
});

// ---------------------------------------------------------------------------
// Cenário 5 — regressão: email_hash sozinho ainda é sinal válido
// ---------------------------------------------------------------------------

describe('checkEligibility — regressão: email_hash sozinho continua válido', () => {
  it('eligible quando lead.email_hash presente (sem visitor_id/fbc/fbp) — não regrediu na Onda 1', () => {
    const event = makeEvent({
      // sem visitor_id, sem user_data
    });
    const lead: EligibilityLead = {
      email_hash:
        'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      phone_hash: null,
    };

    const result = checkEligibility(event, lead, makeLaunchConfig());

    expect(result.eligible).toBe(true);
  });

  it('eligible quando lead.phone_hash presente (sem visitor_id/fbc/fbp/email)', () => {
    const event = makeEvent({});
    const lead: EligibilityLead = {
      email_hash: null,
      phone_hash:
        'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',
    };

    const result = checkEligibility(event, lead, makeLaunchConfig());

    expect(result.eligible).toBe(true);
  });
});
