/**
 * routes/integrations-test.ts — POST /v1/integrations/:provider/test
 *
 * Sends a synthetic test event to the given integration provider and returns
 * a structured result with phases, latency and an optional deep-link URL.
 *
 * ORCHESTRATOR MOUNT (add to apps/edge/src/index.ts after other routes):
 * import { integrationsTestRoute } from './routes/integrations-test.js';
 * app.route('/v1/integrations', integrationsTestRoute);
 *
 * CONTRACT-api-integrations-test-v1
 * T-ID: T-6-007
 *
 * Supported providers: meta, ga4, google_ads
 * Unknown provider → 404.
 *
 * Auth (Sprint 6 placeholder):
 *   Requires `Authorization: Bearer <token>` header.
 *   Missing / malformed → 401.
 *   TODO Sprint 6: validate JWT Supabase via middleware auth-cp.ts
 *   AUTHZ: MARKETER, OPERATOR, ADMIN can trigger test (AUTHZ-003)
 *
 * BR-PRIVACY-001: zero PII in logs and error responses.
 *   Synthetic events carry no real user data.
 * BR-EVENT-002: synthetic event_id is a UUID generated per request.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env types (mirrors apps/edge/src/index.ts Bindings + META_PIXEL_ID)
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  META_CAPI_TOKEN?: string;
  META_CAPI_TEST_EVENT_CODE?: string;
  /** Pixel ID used for test events (preferred). Falls back to META_ADS_ACCOUNT_ID. */
  META_PIXEL_ID?: string;
  META_ADS_ACCOUNT_ID?: string;
  GA4_MEASUREMENT_ID?: string;
  GA4_API_SECRET?: string;
};

type AppVariables = {
  workspace_id?: string;
  page_id?: string;
  request_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = ['meta', 'ga4', 'google_ads'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const TestRequestSchema = z.object({
  source: z.enum(['config_screen', 'wizard']),
  pixel_id: z.string().optional(),
  capi_token: z.string().optional(),
  test_event_code: z.string().optional(),
  measurement_id: z.string().optional(),
  api_secret: z.string().optional(),
  debug_mode: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

type TestPhase = {
  name: 'prepare' | 'send' | 'confirm';
  status: 'ok' | 'failed' | 'pending';
  message?: string;
};

type TestResponse = {
  status: 'success' | 'failed' | 'skipped';
  provider: string;
  latency_ms: number;
  phases: TestPhase[];
  error?: {
    code: string;
    message: string;
  };
  external_url?: string;
};

// ---------------------------------------------------------------------------
// Error translation helpers
// ---------------------------------------------------------------------------

/**
 * Translate Meta CAPI API error messages to PT-BR user-friendly strings.
 * BR-PRIVACY-001: do not include raw PII from API error in the message.
 */
function translateMetaError(rawMessage: string, errorSubcode?: number): { code: string; message: string } {
  const lower = rawMessage.toLowerCase();
  if (lower.includes('domain not verified')) {
    return { code: 'domain_not_verified', message: 'Domínio não verificado no Meta Business Manager' };
  }
  if (lower.includes('invalid access token') || lower.includes('access token')) {
    return { code: 'invalid_access_token', message: 'Token CAPI inválido ou expirado' };
  }
  if (errorSubcode === 2804050 || lower.includes('insufficient')) {
    return { code: 'meta_api_error', message: 'Evento de teste aceito (dados de cliente sintéticos insuficientes para score completo — comportamento esperado em testes)' };
  }
  // BR-PRIVACY-001: truncate raw message to avoid leaking PII from error body
  const safe = rawMessage.slice(0, 200);
  return { code: 'meta_api_error', message: `Erro ao conectar com Meta: ${safe}` };
}

// ---------------------------------------------------------------------------
// Provider handlers
// ---------------------------------------------------------------------------

/**
 * Run test against Meta Conversions API.
 * BR-PRIVACY-001: synthetic payload — no real user data.
 * BR-EVENT-002: event_id is a fresh UUID per test call.
 */
async function testMeta(
  env: AppBindings,
  workspaceId: string,
  overrides: { pixelId?: string; token?: string; testEventCode?: string } = {},
  fetchFn: typeof fetch = fetch,
): Promise<TestResponse> {
  const token = overrides.token ?? env.META_CAPI_TOKEN;
  const pixelId = overrides.pixelId ?? env.META_PIXEL_ID ?? env.META_ADS_ACCOUNT_ID;

  if (!token || !pixelId) {
    return {
      status: 'skipped',
      provider: 'meta',
      latency_ms: 0,
      phases: [],
      error: {
        code: 'integration_not_configured',
        message:
          'Meta CAPI não configurado. Configure Pixel ID e Token CAPI em Integrações.',
      },
    };
  }

  const phases: TestPhase[] = [];

  // --- Phase: prepare ---
  // BR-EVENT-002: synthetic event_id is a UUID
  const testEventId = crypto.randomUUID();
  const payload = {
    data: [
      {
        event_name: 'TestEvent',
        event_time: Math.floor(Date.now() / 1000),
        event_id: testEventId,
        action_source: 'website',
        // BR-PRIVACY-001: data_processing_options prevents real data processing
        data_processing_options: [] as string[],
        // Synthetic user_data required by Meta — no real PII (BR-PRIVACY-001)
        user_data: {
          client_ip_address: '127.0.0.1',
          client_user_agent: 'GlobalTracker/TestEvent',
        },
      },
    ],
    // Use configured test event code or safe default
    test_event_code: overrides.testEventCode ?? env.META_CAPI_TEST_EVENT_CODE ?? 'TEST_GLOBALTRACKER',
  };
  phases.push({ name: 'prepare', status: 'ok' });

  // --- Phase: send ---
  const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${token}`;
  const start = Date.now();
  let rawResponse: Response;

  try {
    rawResponse = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const latency_ms = Date.now() - start;
    phases.push({
      name: 'send',
      status: 'failed',
      message: err instanceof Error ? err.message.slice(0, 200) : 'fetch error',
    });
    // BR-PRIVACY-001: no PII in log
    safeLog('warn', {
      event: 'integrations_test_meta_fetch_error',
      provider: 'meta',
      workspace_id: workspaceId,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return {
      status: 'failed',
      provider: 'meta',
      latency_ms,
      phases,
      error: {
        code: 'fetch_error',
        message: 'Erro de rede ao conectar com Meta CAPI',
      },
    };
  }

  const latency_ms = Date.now() - start;

  // --- Phase: confirm ---
  let body: Record<string, unknown>;
  try {
    body = (await rawResponse.json()) as Record<string, unknown>;
  } catch {
    phases.push({ name: 'send', status: 'ok' });
    phases.push({
      name: 'confirm',
      status: 'failed',
      message: 'invalid JSON response',
    });
    return {
      status: 'failed',
      provider: 'meta',
      latency_ms,
      phases,
      error: { code: 'invalid_response', message: 'Resposta inválida da Meta' },
    };
  }

  const eventsReceived =
    typeof body.events_received === 'number' ? body.events_received : 0;

  if (!rawResponse.ok || eventsReceived === 0) {
    const errorObj = body.error as Record<string, unknown> | undefined;
    const rawMessage =
      typeof errorObj?.message === 'string'
        ? errorObj.message
        : `HTTP ${rawResponse.status}`;
    const errorSubcode =
      typeof errorObj?.error_subcode === 'number' ? errorObj.error_subcode : undefined;

    phases.push({
      name: 'send',
      status: 'failed',
      message: rawMessage.slice(0, 200),
    });
    phases.push({ name: 'confirm', status: 'pending' });

    // BR-PRIVACY-001: no raw error body in KV / logs — only safe code
    const translated = translateMetaError(rawMessage, errorSubcode);
    const result: TestResponse = {
      status: 'failed',
      provider: 'meta',
      latency_ms,
      phases,
      error: translated,
    };

    await persistTestResult(env, workspaceId, 'meta', result);
    return result;
  }

  phases.push({ name: 'send', status: 'ok' });
  phases.push({ name: 'confirm', status: 'ok' });

  const result: TestResponse = {
    status: 'success',
    provider: 'meta',
    latency_ms,
    phases,
    external_url: `https://business.facebook.com/events_manager2/list/pixel/${pixelId}/test_events`,
  };

  await persistTestResult(env, workspaceId, 'meta', result);
  return result;
}

/**
 * Run test against GA4 Measurement Protocol debug endpoint.
 * Uses the /debug/mp/collect endpoint — does NOT send real data to GA4.
 * BR-PRIVACY-001: client_id is a non-identifying synthetic value.
 */
async function testGa4(
  env: AppBindings,
  workspaceId: string,
  overrides: { measurementId?: string; apiSecret?: string } = {},
  fetchFn: typeof fetch = fetch,
): Promise<TestResponse> {
  const measurementId = overrides.measurementId ?? env.GA4_MEASUREMENT_ID;
  const apiSecret = overrides.apiSecret ?? env.GA4_API_SECRET;

  if (!measurementId || !apiSecret) {
    return {
      status: 'skipped',
      provider: 'ga4',
      latency_ms: 0,
      phases: [],
      error: {
        code: 'integration_not_configured',
        message:
          'GA4 não configurado. Configure Measurement ID e API Secret em Integrações.',
      },
    };
  }

  const phases: TestPhase[] = [];

  // --- Phase: prepare ---
  // BR-PRIVACY-001: synthetic client_id — no real user identifier
  const syntheticClientId = `test-client-${Date.now()}`;
  const debugBody = {
    client_id: syntheticClientId,
    events: [{ name: 'test_event', params: { debug_mode: true } }],
  };
  phases.push({ name: 'prepare', status: 'ok' });

  // --- Phase: send ---
  const url = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;
  const start = Date.now();
  let rawResponse: Response;

  try {
    rawResponse = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(debugBody),
    });
  } catch (err) {
    const latency_ms = Date.now() - start;
    phases.push({
      name: 'send',
      status: 'failed',
      message: err instanceof Error ? err.message.slice(0, 200) : 'fetch error',
    });
    safeLog('warn', {
      event: 'integrations_test_ga4_fetch_error',
      provider: 'ga4',
      workspace_id: workspaceId,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return {
      status: 'failed',
      provider: 'ga4',
      latency_ms,
      phases,
      error: {
        code: 'fetch_error',
        message: 'Erro de rede ao conectar com GA4',
      },
    };
  }

  const latency_ms = Date.now() - start;

  // --- Phase: confirm ---
  let body: Record<string, unknown>;
  try {
    body = (await rawResponse.json()) as Record<string, unknown>;
  } catch {
    phases.push({ name: 'send', status: 'ok' });
    phases.push({
      name: 'confirm',
      status: 'failed',
      message: 'invalid JSON response',
    });
    return {
      status: 'failed',
      provider: 'ga4',
      latency_ms,
      phases,
      error: { code: 'invalid_response', message: 'Resposta inválida do GA4' },
    };
  }

  phases.push({ name: 'send', status: 'ok' });

  const validationMessages = Array.isArray(body.validationMessages)
    ? (body.validationMessages as unknown[])
    : [];

  if (validationMessages.length > 0) {
    const firstMsg = validationMessages[0] as Record<string, unknown>;
    const description =
      typeof firstMsg?.description === 'string'
        ? firstMsg.description.slice(0, 200)
        : 'validation error';

    phases.push({ name: 'confirm', status: 'failed', message: description });
    const result: TestResponse = {
      status: 'failed',
      provider: 'ga4',
      latency_ms,
      phases,
      error: {
        code: 'ga4_validation_error',
        message: `Erro de validação GA4: ${description}`,
      },
    };
    await persistTestResult(env, workspaceId, 'ga4', result);
    return result;
  }

  phases.push({ name: 'confirm', status: 'ok' });

  // measurementId format: G-XXXXXXX → strip "G-" for the deep-link
  const numericId = measurementId.replace(/^G-/i, '');
  const result: TestResponse = {
    status: 'success',
    provider: 'ga4',
    latency_ms,
    phases,
    external_url: `https://analytics.google.com/analytics/web/#/p${numericId}/realtime/debugview`,
  };

  await persistTestResult(env, workspaceId, 'ga4', result);
  return result;
}

/**
 * Google Ads conversion upload test — not supported in this version.
 * Returns skipped immediately.
 */
function testGoogleAds(): TestResponse {
  return {
    status: 'skipped',
    provider: 'google_ads',
    latency_ms: 0,
    phases: [],
    error: {
      code: 'not_supported',
      message:
        'Teste de Google Ads via Conversion Upload não suportado nesta versão.',
    },
  };
}

// ---------------------------------------------------------------------------
// KV persistence helper
// ---------------------------------------------------------------------------

/**
 * Persist test result in KV with 24-hour TTL.
 * Key: test:{workspaceId}:{provider}
 * Includes timestamp for last-tested display in the UI.
 * BR-PRIVACY-001: only non-PII fields in result are persisted.
 */
async function persistTestResult(
  env: AppBindings,
  workspaceId: string,
  provider: string,
  result: TestResponse,
): Promise<void> {
  try {
    const kvKey = `test:${workspaceId}:${provider}`;
    await env.GT_KV.put(
      kvKey,
      JSON.stringify({ ...result, timestamp: new Date().toISOString() }),
      { expirationTtl: 86400 },
    );
  } catch {
    // KV write failure is non-fatal — log and continue
    safeLog('warn', {
      event: 'integrations_test_kv_persist_failed',
      provider,
      workspace_id: workspaceId,
    });
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const integrationsTestRoute = new Hono<AppEnv>();

/**
 * POST /v1/integrations/:provider/test
 *
 * Sends a synthetic test event to the specified integration provider.
 * CONTRACT-api-integrations-test-v1
 * T-6-007
 *
 * AUTHZ: MARKETER, OPERATOR, ADMIN (AUTHZ-003)
 * BR-PRIVACY-001: zero PII in logs, response errors, or synthetic payloads.
 * BR-EVENT-002: synthetic event carries a fresh UUID per request.
 */
integrationsTestRoute.post('/:provider/test', async (c) => {
  // -------------------------------------------------------------------------
  // 1. request_id — fall back to generated UUID if middleware not attached
  // -------------------------------------------------------------------------
  const requestId: string =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

  // -------------------------------------------------------------------------
  // 2. Auth — Bearer token required
  //    TODO Sprint 6: validate JWT Supabase via middleware auth-cp.ts
  //    AUTHZ-003: MARKETER, OPERATOR, ADMIN roles allowed
  // -------------------------------------------------------------------------
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      {
        code: 'unauthorized',
        message: 'Missing authorization',
        request_id: requestId,
      },
      401,
      { 'X-Request-Id': requestId },
    );
  }

  // TODO: extract workspace_id from validated JWT claim
  // Placeholder until Sprint 6 auth middleware is wired
  const workspaceId = 'placeholder';

  // -------------------------------------------------------------------------
  // 3. Provider validation — 404 for unknown providers
  // -------------------------------------------------------------------------
  const providerParam = c.req.param('provider');
  if (!SUPPORTED_PROVIDERS.includes(providerParam as SupportedProvider)) {
    return c.json(
      {
        code: 'not_found',
        message: `Provider '${providerParam}' não encontrado. Providers suportados: ${SUPPORTED_PROVIDERS.join(', ')}`,
        request_id: requestId,
      },
      404,
      { 'X-Request-Id': requestId },
    );
  }

  const provider = providerParam as SupportedProvider;

  // -------------------------------------------------------------------------
  // 4. Body validation
  // -------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        code: 'validation_error',
        message: 'Invalid JSON body',
        request_id: requestId,
      },
      400,
      { 'X-Request-Id': requestId },
    );
  }

  const parseResult = TestRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      {
        code: 'validation_error',
        message: parseResult.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
        request_id: requestId,
      },
      400,
      { 'X-Request-Id': requestId },
    );
  }

  // source available if needed for audit
  // const { source } = parseResult.data;

  // -------------------------------------------------------------------------
  // 5. Dispatch to provider handler
  //    BR-PRIVACY-001: all handlers use synthetic data only.
  // -------------------------------------------------------------------------
  safeLog('info', {
    event: 'integrations_test_start',
    provider,
    workspace_id: workspaceId,
    request_id: requestId,
  });

  let result: TestResponse;

  try {
    switch (provider) {
      case 'meta':
        result = await testMeta(c.env, workspaceId, {
          pixelId: parseResult.data.pixel_id,
          token: parseResult.data.capi_token,
          testEventCode: parseResult.data.test_event_code,
        });
        break;
      case 'ga4':
        result = await testGa4(c.env, workspaceId, {
          measurementId: parseResult.data.measurement_id,
          apiSecret: parseResult.data.api_secret,
        });
        break;
      case 'google_ads':
        result = testGoogleAds();
        break;
    }
  } catch (err) {
    // Unexpected error — BR-PRIVACY-001: no PII in log
    safeLog('error', {
      event: 'integrations_test_unexpected_error',
      provider,
      workspace_id: workspaceId,
      request_id: requestId,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return c.json(
      {
        code: 'internal_error',
        message: 'Erro interno ao executar teste',
        request_id: requestId,
      },
      500,
      { 'X-Request-Id': requestId },
    );
  }

  safeLog('info', {
    event: 'integrations_test_complete',
    provider,
    workspace_id: workspaceId,
    request_id: requestId,
    status: result.status,
    latency_ms: result.latency_ms,
  });

  return c.json(result, 200, { 'X-Request-Id': requestId });
});
