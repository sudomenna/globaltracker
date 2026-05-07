/**
 * Unit tests for Meta CAPI mapper — external_id (visitor_id) coverage.
 *
 * T-16-001D — cobre as mudanças da Onda 1 (T-16-001A/B/C):
 *   - DispatchableEvent.visitor_id é populado em userData.external_id (PLANO)
 *   - external_id ausente quando visitor_id ausente
 *   - external_id coexiste com em/ph/fn/ln/fbc/fbp
 *   - external_id não interfere em custom_data
 *
 * BRs cobertas:
 *   BR-CONSENT-003: external_id é anônimo (UUID v4) — não-PII; passa em PLANO
 *                   (Meta hashea internamente).
 *   BR-DISPATCH-001: event_id é preservado (regressão coberta no arquivo legado).
 */

import { describe, expect, it } from 'vitest';

import {
  type DispatchableEvent,
  type DispatchableLead,
  mapEventToMetaPayload,
} from '../../../../apps/edge/src/dispatchers/meta-capi/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2024-05-02T00:00:00.000Z');
const VISITOR_UUID = 'abc-uuid-123';

function makeEvent(
  overrides: Partial<DispatchableEvent> = {},
): DispatchableEvent {
  return {
    event_id: 'evt_01HXK2N3P4QR5ST6UV7WX8YZ90',
    event_name: 'PageView',
    event_time: FIXED_DATE,
    lead_id: null,
    workspace_id: 'ws-uuid-001',
    ...overrides,
  };
}

function makeLeadFull(
  overrides: Partial<DispatchableLead> = {},
): DispatchableLead {
  return {
    email_hash_external:
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    phone_hash_external:
      'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',
    fn_hash:
      'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4',
    ln_hash:
      'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cenário 1 — external_id populated when event.visitor_id is present
// ---------------------------------------------------------------------------

describe('mapEventToMetaPayload — external_id from visitor_id', () => {
  it('populates user_data.external_id with visitor_id verbatim (PLANO, sem hash) when visitor_id present and lead absent', () => {
    const event = makeEvent({
      visitor_id: VISITOR_UUID,
      // sem fbc/fbp/lead — só visitor_id como sinal
    });

    const payload = mapEventToMetaPayload(event, null);

    // BR-CONSENT-003: external_id é PLANO (Meta hashea internamente)
    expect(payload.user_data.external_id).toBe(VISITOR_UUID);
    // Não pode ter sido hasheado: deve aparecer literal
    expect(payload.user_data.external_id).not.toMatch(/^[a-f0-9]{64}$/);
  });

  it('omits user_data.external_id when event.visitor_id is undefined (lead with em ainda passa em)', () => {
    const event = makeEvent({
      // visitor_id omitido
    });
    const lead = makeLeadFull();

    const payload = mapEventToMetaPayload(event, lead);

    expect(payload.user_data.external_id).toBeUndefined();
    expect('external_id' in payload.user_data).toBe(false);
    // Mas em do lead permanece presente
    expect(payload.user_data.em).toBe(lead.email_hash_external);
  });

  it('omits user_data.external_id when event.visitor_id is null (regressão: null é falsy)', () => {
    const event = makeEvent({ visitor_id: null });

    const payload = mapEventToMetaPayload(event, null);

    expect(payload.user_data.external_id).toBeUndefined();
    expect('external_id' in payload.user_data).toBe(false);
  });

  it('omits user_data.external_id when event.visitor_id is empty string (regressão: string vazia é falsy)', () => {
    const event = makeEvent({ visitor_id: '' });

    const payload = mapEventToMetaPayload(event, null);

    expect(payload.user_data.external_id).toBeUndefined();
    expect('external_id' in payload.user_data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cenário 3 — external_id coexists with all other user_data fields
// ---------------------------------------------------------------------------

describe('mapEventToMetaPayload — external_id coexists with em/ph/fn/ln/fbc/fbp', () => {
  it('populates ALL user_data fields when visitor_id + fbc + fbp + lead em/ph/fn/ln present', () => {
    const event = makeEvent({
      visitor_id: VISITOR_UUID,
      user_data: {
        fbc: 'fb.1.1714608000000.AbCdEfGhIjKlMn',
        fbp: 'fb.1.1714600000000.1234567890',
      },
    });
    const lead = makeLeadFull();

    const payload = mapEventToMetaPayload(event, lead);

    // Todos os 7 sinais presentes
    expect(payload.user_data.em).toBe(lead.email_hash_external);
    expect(payload.user_data.ph).toBe(lead.phone_hash_external);
    expect(payload.user_data.fn).toBe(lead.fn_hash);
    expect(payload.user_data.ln).toBe(lead.ln_hash);
    expect(payload.user_data.fbc).toBe('fb.1.1714608000000.AbCdEfGhIjKlMn');
    expect(payload.user_data.fbp).toBe('fb.1.1714600000000.1234567890');
    expect(payload.user_data.external_id).toBe(VISITOR_UUID);
  });
});

// ---------------------------------------------------------------------------
// Cenário 4 — regressão: external_id não interfere em custom_data
// ---------------------------------------------------------------------------

describe('mapEventToMetaPayload — external_id does not interfere with custom_data', () => {
  it('Purchase event with visitor_id keeps custom_data (value/currency) AND external_id populated', () => {
    const event = makeEvent({
      event_name: 'Purchase',
      visitor_id: VISITOR_UUID,
      custom_data: {
        value: 197.0,
        currency: 'BRL',
        order_id: 'ORD-2024-001',
      },
    });

    const payload = mapEventToMetaPayload(event, null);

    // custom_data preservado
    expect(payload.custom_data).toEqual({
      value: 197.0,
      currency: 'BRL',
      order_id: 'ORD-2024-001',
    });
    // external_id populado em paralelo
    expect(payload.user_data.external_id).toBe(VISITOR_UUID);
    // event_name traduzido corretamente
    expect(payload.event_name).toBe('Purchase');
  });
});
