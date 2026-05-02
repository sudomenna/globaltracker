/**
 * Integration tests — GET /v1/help/skip-reason/:reason
 *
 * CONTRACT-api-help-skip-reason-v1
 *
 * Covers:
 *   §1 skip_reason — consent_denied:ad_user_data → 200 PT-BR
 *   §2 Meta CAPI   — meta:invalid_pixel_id       → 200 com ação sugerida
 *   §2 GA4         — ga4:invalid_measurement_id  → 200 com ação sugerida
 *   §2 Google Ads  — google_ads:gclid_not_found  → 200 sem ação (informativo)
 *   §3 HTTP        — http_403_origin_not_allowed  → 200
 *   §3 HTTP        — http_401_invalid_token       → 200
 *   Unknown reason → 404 com code=reason_not_found
 *   Cache-Control: max-age=3600 presente em 200
 *   X-Request-Id presente em 200 e 404
 *
 * Test approach: real Hono app, zero DB dependency.
 * Runs with vitest node environment.
 *
 * BR-PRIVACY-001: zero PII em qualquer resposta.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type HelpResponse,
  createHelpRoute,
} from '../../../apps/edge/src/routes/help.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Bindings = { ENVIRONMENT: string };
type Variables = { request_id?: string };

function buildApp(): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route('/v1/help', createHelpRoute());
  return app;
}

async function get(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  reason: string,
): Promise<Response> {
  return app.request(`/v1/help/skip-reason/${encodeURIComponent(reason)}`, {
    method: 'GET',
  });
}

// ---------------------------------------------------------------------------
// §1 — Skip reasons
// ---------------------------------------------------------------------------

describe('GET /v1/help/skip-reason — §1 skip reasons', () => {
  it('returns 200 with PT-BR title and body for consent_denied:ad_user_data', async () => {
    const app = buildApp();
    const res = await get(app, 'consent_denied:ad_user_data');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.reason).toBe('consent_denied:ad_user_data');
    expect(body.title).toBe('Lead negou anúncios');
    expect(body.body).toContain('não autorizou uso de dados para anúncios');
    // BR-PRIVACY-001: zero PII no conteúdo
    expect(JSON.stringify(body)).not.toMatch(/email|phone|cpf/i);
  });

  it('returns 200 for no_user_data with action sugerida', async () => {
    const app = buildApp();
    const res = await get(app, 'no_user_data');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Sem identificador do lead');
    expect(body.body).toContain('Meta exige');
    expect(body.action).toBeDefined();
    expect(body.action?.label).toBeTruthy();
  });

  it('returns 200 for integration_not_configured with action href to /integrations', async () => {
    const app = buildApp();
    const res = await get(app, 'integration_not_configured');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Integração não configurada');
    expect(body.action?.href).toContain('/integrations');
  });

  it('returns 200 for archived_launch with no action (informativo)', async () => {
    const app = buildApp();
    const res = await get(app, 'archived_launch');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Lançamento arquivado');
    expect(body.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 — Error codes por destino
// ---------------------------------------------------------------------------

describe('GET /v1/help/skip-reason — §2 Meta CAPI error codes', () => {
  it('returns 200 for meta:invalid_pixel_id with ação sugerida', async () => {
    const app = buildApp();
    const res = await get(app, 'meta:invalid_pixel_id');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.reason).toBe('meta:invalid_pixel_id');
    expect(body.title).toBe('Pixel ID inválido');
    expect(body.body).toContain('Pixel ID');
    expect(body.action).toBeDefined();
    expect(body.action?.href).toContain('/integrations/meta');
  });

  it('returns 200 for meta:rate_limited with no action (auto-retry)', async () => {
    const app = buildApp();
    const res = await get(app, 'meta:rate_limited');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Limite de requests do Meta atingido');
    expect(body.action).toBeUndefined();
  });
});

describe('GET /v1/help/skip-reason — §2 GA4 error codes', () => {
  it('returns 200 for ga4:invalid_measurement_id with ação', async () => {
    const app = buildApp();
    const res = await get(app, 'ga4:invalid_measurement_id');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.reason).toBe('ga4:invalid_measurement_id');
    expect(body.title).toBe('Measurement ID inválido');
    expect(body.action?.href).toContain('/integrations/ga4');
  });

  it('returns 200 for ga4:validation_failed', async () => {
    const app = buildApp();
    const res = await get(app, 'ga4:validation_failed');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Payload rejeitado pelo GA4');
  });
});

describe('GET /v1/help/skip-reason — §2 Google Ads error codes', () => {
  it('returns 200 for google_ads:gclid_not_found without action', async () => {
    const app = buildApp();
    const res = await get(app, 'google_ads:gclid_not_found');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.reason).toBe('google_ads:gclid_not_found');
    expect(body.title).toBe('Clique não encontrado');
    expect(body.action).toBeUndefined();
  });

  it('returns 200 for google_ads:conversion_outside_window with action', async () => {
    const app = buildApp();
    const res = await get(app, 'google_ads:conversion_outside_window');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Conversão fora da janela');
    expect(body.action).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §3 — Erros HTTP do Edge
// ---------------------------------------------------------------------------

describe('GET /v1/help/skip-reason — §3 HTTP error codes', () => {
  it('returns 200 for http_403_origin_not_allowed', async () => {
    const app = buildApp();
    const res = await get(app, 'http_403_origin_not_allowed');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.reason).toBe('http_403_origin_not_allowed');
    expect(body.title).toBe('Domínio não autorizado');
    expect(body.body).toContain('domínio');
    expect(body.action).toBeDefined();
  });

  it('returns 200 for http_401_invalid_token with action to rotacionar token', async () => {
    const app = buildApp();
    const res = await get(app, 'http_401_invalid_token');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Token da página inválido');
    expect(body.action?.label).toContain('Rotacionar token');
  });

  it('returns 200 for http_429_rate_limited', async () => {
    const app = buildApp();
    const res = await get(app, 'http_429_rate_limited');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Limite de envios atingido');
  });

  it('returns 200 for http_410_archived_launch', async () => {
    const app = buildApp();
    const res = await get(app, 'http_410_archived_launch');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Lançamento arquivado');
    expect(body.action?.href).toContain('/launches');
  });

  it('returns 200 for http_400_bot_detected without action', async () => {
    const app = buildApp();
    const res = await get(app, 'http_400_bot_detected');

    expect(res.status).toBe(200);
    const body = await res.json<HelpResponse>();

    expect(body.title).toBe('Tentativa bloqueada (bot)');
    expect(body.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 404 — unknown reason
// ---------------------------------------------------------------------------

describe('GET /v1/help/skip-reason — 404 for unknown reason', () => {
  it('returns 404 with code=reason_not_found for unknown reason', async () => {
    const app = buildApp();
    const res = await get(app, 'totally_unknown_reason_xyz');

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string; message: string }>();
    expect(body.code).toBe('reason_not_found');
    expect(body.message).toBe('Reason not in help catalog');
    // BR-PRIVACY-001: no PII
    expect(JSON.stringify(body)).not.toMatch(/email|phone|name/i);
  });

  it('returns 404 for empty-ish reason that maps to nothing', async () => {
    const app = buildApp();
    // "x" is valid (length >= 1) but not in catalog
    const res = await get(app, 'x');

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('GET /v1/help/skip-reason — response headers', () => {
  it('returns Cache-Control: max-age=3600 on 200', async () => {
    const app = buildApp();
    const res = await get(app, 'consent_denied:ad_user_data');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
  });

  it('returns X-Request-Id on 200', async () => {
    const app = buildApp();
    const res = await get(app, 'no_user_data');

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns X-Request-Id on 404', async () => {
    const app = buildApp();
    const res = await get(app, 'nonexistent_reason');

    expect(res.status).toBe(404);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});
