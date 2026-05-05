/**
 * routes/config.ts — GET /v1/config/:launch_public_id/:page_public_id
 *
 * Returns sanitised public configuration for the tracker client.
 *
 * CONTRACT-api-config-v1
 *
 * Auth: workspace_id + page_id are set by authPublicToken middleware before this
 *   handler is invoked. If either is absent the request was not authenticated
 *   correctly — return 401.
 *
 * Cache: KV key `config:v1:<page_id>` with TTL 60s.
 * ETag: SHA-256 truncated to 8 hex chars of the JSON response body.
 *   If-None-Match match → 304 Not Modified.
 *
 * Fallback: when c.env.DB is undefined (Hyperdrive not yet configured) the
 *   handler returns a minimal safe response (events_enabled: false) with status
 *   200 so the tracker degrades gracefully instead of surfacing 500.
 *
 * INV-PAGE-007: workspace_id isolation enforced by auth middleware upstream.
 * BR-PRIVACY-001: zero PII in logs — only opaque IDs are emitted.
 */

import { Hono } from 'hono';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env types (mirrors apps/edge/src/index.ts)
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  /** Hyperdrive binding — undefined until configured in production. */
  DB?: Fetcher;
};

type AppVariables = {
  /** Populated by authPublicToken middleware. */
  workspace_id: string;
  /** Populated by authPublicToken middleware. */
  page_id: string;
  /** Populated by sanitizeLogs middleware. */
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Page config shape returned by DB lookup
// ---------------------------------------------------------------------------

/** Minimal page record the handler needs — injected via GetPageConfigFn. */
export interface PageConfigRow {
  status: 'draft' | 'active' | 'paused' | 'archived';
  eventConfig: Record<string, unknown>;
  /** Allowed events list — extracted from eventConfig if present. */
  allowedEventNames: string[];
  /** Custom data schema — extracted from eventConfig if present. */
  customDataSchema: Record<string, unknown>;
  /** Auto fire PageView on tracker init — extracted from eventConfig.auto_page_view. */
  autoPageView: boolean;
  metaPixelId: string | null;
  ga4MeasurementId: string | null;
  leadTokenTtlDays: number;
}

/**
 * DB query function injected by the caller.
 * domain-author wires this up via apps/edge/src/lib/page.ts → getPageConfig().
 * Receives env so the closure can resolve a per-request DB connection (Hyperdrive).
 */
export type GetPageConfigFn = (
  workspaceId: string,
  pageId: string,
  env: unknown,
) => Promise<PageConfigRow | null>;

// ---------------------------------------------------------------------------
// Response shape (CONTRACT-api-config-v1)
// ---------------------------------------------------------------------------

interface ConfigResponse {
  event_config: {
    events_enabled: boolean;
    allowed_event_names: string[];
    custom_data_schema: Record<string, unknown>;
    auto_page_view: boolean;
  };
  pixel_policy: {
    meta_pixel_id: string | null;
    ga4_measurement_id: string | null;
  };
  endpoints: {
    events: string;
    lead: string;
    redirect: string;
  };
  schema_version: 1;
  lead_token_settings: {
    ttl_days: number;
  };
  /** Internal cache hint — stripped from ETag / Cache-Control calculation. */
  _cache?: 'hit' | 'miss' | 'fallback';
}

// ---------------------------------------------------------------------------
// Static endpoints (contract-stable)
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  events: '/v1/events',
  lead: '/v1/lead',
  redirect: '/r/:slug',
} as const;

const DEFAULT_LEAD_TOKEN_TTL_DAYS = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex (full) of a UTF-8 string using Web Crypto API.
 * Used to compute ETag (first 8 chars).
 *
 * BR-PRIVACY-001: only called on serialised config — no PII in input.
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the canonical response body from a PageConfigRow.
 * Does NOT set the `_cache` field — caller does that.
 */
function buildResponseBody(row: PageConfigRow): ConfigResponse {
  return {
    event_config: {
      events_enabled: true,
      allowed_event_names: row.allowedEventNames,
      custom_data_schema: row.customDataSchema,
      auto_page_view: row.autoPageView,
    },
    pixel_policy: {
      meta_pixel_id: row.metaPixelId,
      ga4_measurement_id: row.ga4MeasurementId,
    },
    endpoints: ENDPOINTS,
    schema_version: 1,
    lead_token_settings: {
      ttl_days: row.leadTokenTtlDays || DEFAULT_LEAD_TOKEN_TTL_DAYS,
    },
  };
}

/** Minimal fallback response when DB is unavailable. */
function buildFallbackBody(): ConfigResponse {
  return {
    event_config: {
      events_enabled: false,
      allowed_event_names: [],
      custom_data_schema: {},
      auto_page_view: false,
    },
    pixel_policy: {
      meta_pixel_id: null,
      ga4_measurement_id: null,
    },
    endpoints: ENDPOINTS,
    schema_version: 1,
    lead_token_settings: {
      ttl_days: DEFAULT_LEAD_TOKEN_TTL_DAYS,
    },
    _cache: 'fallback',
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the config sub-router, injecting the DB lookup function.
 *
 * Usage in index.ts:
 * ```ts
 * import { createConfigRoute } from './routes/config.js';
 * app.route('/v1/config', createConfigRoute(getPageConfigFn));
 * ```
 *
 * @param getPageConfig - async function that queries page config by workspace_id + page_id.
 */
export function createConfigRoute(
  getPageConfig: GetPageConfigFn,
): Hono<AppEnv> {
  const configRoute = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // GET /:launch_public_id/:page_public_id
  // CONTRACT-api-config-v1
  // -------------------------------------------------------------------------
  configRoute.get('/:launch_public_id/:page_public_id', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    const pageId = c.get('page_id');

    // Auth guard — workspace_id and page_id must be populated by middleware.
    // INV-PAGE-007: token must be bound to this workspace.
    if (!workspaceId || !pageId) {
      // BR-PRIVACY-001: no PII in error response
      return c.json({ error: 'invalid_token', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    const cacheKey = `config:v1:${pageId}`;

    // -----------------------------------------------------------------------
    // KV cache lookup
    // -----------------------------------------------------------------------
    const cached = await c.env.GT_KV.get<ConfigResponse>(cacheKey, {
      type: 'json',
    });

    if (cached !== null) {
      // Cache hit
      // Remove internal _cache annotation from the body used for ETag so the
      // ETag stays stable regardless of which code path populated the KV entry.
      const { _cache: _ignored, ...bodyForEtag } = cached;
      const bodyStr = JSON.stringify(bodyForEtag);
      const etag = `"${(await sha256Hex(bodyStr)).slice(0, 8)}"`;

      // ETag conditional — 304 Not Modified
      const ifNoneMatch = c.req.header('If-None-Match');
      if (ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'X-Request-Id': requestId,
            'Cache-Control': 'public, max-age=60',
          },
        });
      }

      // BR-PRIVACY-001: log only opaque IDs
      safeLog('info', {
        event: 'config_cache_hit',
        request_id: requestId,
        workspace_id: workspaceId,
        page_id: pageId,
      });

      const responseBody: ConfigResponse = { ...bodyForEtag, _cache: 'hit' };

      return c.json(responseBody, 200, {
        'Cache-Control': 'public, max-age=60',
        ETag: etag,
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // Cache miss — attempt DB lookup
    // -----------------------------------------------------------------------

    // Fallback: DB binding absent (Hyperdrive not yet configured) — return
    // minimal safe response so the tracker degrades gracefully instead of 500.
    if (c.env.DB === undefined) {
      safeLog('info', {
        event: 'config_cache_miss',
        request_id: requestId,
        workspace_id: workspaceId,
        page_id: pageId,
      });

      const fallbackBody = buildFallbackBody();
      const { _cache: _ignored, ...bodyForEtag } = fallbackBody;
      const etag = `"${(await sha256Hex(JSON.stringify(bodyForEtag))).slice(0, 8)}"`;

      return c.json(fallbackBody, 200, {
        'Cache-Control': 'public, max-age=60',
        ETag: etag,
        'X-Request-Id': requestId,
      });
    }

    // DB lookup — env passed so the closure resolves Hyperdrive connection per request
    let row: PageConfigRow | null;
    try {
      row = await getPageConfig(workspaceId, pageId, c.env);
    } catch (err) {
      // Unexpected DB error — do not surface details
      // BR-PRIVACY-001: no PII in log
      safeLog('error', {
        event: 'config_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        page_id: pageId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json({ error: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    // Page not found
    if (row === null) {
      return c.json({ error: 'page_not_found', request_id: requestId }, 404, {
        'X-Request-Id': requestId,
      });
    }

    // Page archived — 410 Gone (INV-PAGE-007 check: token still bound to this workspace)
    if (row.status === 'archived') {
      return c.json({ error: 'archived', request_id: requestId }, 410, {
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // Build response, compute ETag, write KV cache
    // -----------------------------------------------------------------------
    const body = buildResponseBody(row);
    const bodyStr = JSON.stringify(body);
    const etag = `"${(await sha256Hex(bodyStr)).slice(0, 8)}"`;

    // Write to KV with TTL 60s (fire-and-forget — do not await to avoid
    // blocking response; errors here are non-critical).
    // executionCtx may not be available in non-CF runtimes (e.g. vitest node env);
    // fall back to an unawaited promise in that case.
    const kvWritePromise = c.env.GT_KV.put(cacheKey, JSON.stringify(body), {
      expirationTtl: 60,
    }).catch((err) => {
      // BR-PRIVACY-001: no PII
      safeLog('error', {
        event: 'config_kv_write_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        page_id: pageId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
    });
    try {
      c.executionCtx.waitUntil(kvWritePromise);
    } catch {
      // executionCtx unavailable (non-CF runtime) — promise already running
    }

    // ETag conditional — 304 Not Modified
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'X-Request-Id': requestId,
          'Cache-Control': 'public, max-age=60',
        },
      });
    }

    // BR-PRIVACY-001: log only opaque IDs
    safeLog('info', {
      event: 'config_cache_miss',
      request_id: requestId,
      workspace_id: workspaceId,
      page_id: pageId,
    });

    const responseBody: ConfigResponse = { ...body, _cache: 'miss' };

    return c.json(responseBody, 200, {
      'Cache-Control': 'public, max-age=60',
      ETag: etag,
      'X-Request-Id': requestId,
    });
  });

  return configRoute;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with a no-op DB lookup stub.
// Callers should prefer createConfigRoute(fn) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default configRoute instance — DB lookup always returns null (stub).
 *
 * Wire real lookup in index.ts via:
 * ```ts
 * app.route('/v1/config', createConfigRoute(realGetPageConfig));
 * ```
 */
export const configRoute = createConfigRoute(async (_ws, _pid, _env) => null);
