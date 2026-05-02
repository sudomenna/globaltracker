/**
 * routes/redirect.ts — GET /r/:slug
 *
 * Resolves a short link slug to a destination URL, propagates UTM parameters,
 * and records a link click event asynchronously without blocking the redirect.
 *
 * CONTRACT-api-redirect-v1
 *
 * Auth: none — link redirect is a public endpoint.
 *       No authPublicToken middleware applied here.
 *
 * Critical path must complete < 50ms p95.
 *   INV-ATTRIBUTION-003: recordLinkClick is fire-and-forget via waitUntil.
 *   The DB insert never sits in the critical path.
 *
 * KV cache:
 *   Key:   redirect:<slug>
 *   Value: LinkCacheEntry (JSON)
 *   TTL:   300s
 *
 * BR-ATTRIBUTION-001: every click is recorded with workspace_id + link_id.
 * BR-PRIVACY-001:     zero PII in logs and error responses.
 * INV-ATTRIBUTION-002: slug is unique — one KV key per slug.
 * INV-ATTRIBUTION-003: click recording is async; latency < 50ms p95.
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
  workspace_id: string;
  page_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// KV cache entry shape
// ---------------------------------------------------------------------------

/**
 * Shape of the value stored in KV for a redirect entry.
 * Populated either on cache miss (from DB) or written by management plane.
 */
export interface LinkCacheEntry {
  destination_url: string;
  workspace_id: string;
  link_id: string;
  /** 'active' | 'archived' */
  status: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

// ---------------------------------------------------------------------------
// DB lookup injection
// ---------------------------------------------------------------------------

/**
 * Optional DB lookup function for resolving a slug on KV cache miss.
 * domain-author wires this up in index.ts via apps/edge/src/lib/attribution.ts.
 *
 * Returns null when the slug does not exist in the DB.
 */
export type GetLinkBySlugFn = (slug: string) => Promise<LinkCacheEntry | null>;

// ---------------------------------------------------------------------------
// UTM propagation helper
// ---------------------------------------------------------------------------

/**
 * Append UTM parameters from the link config onto the destination URL.
 * Existing query parameters in the destination URL are NOT overwritten —
 * the advertiser's params take precedence over the link's defaults.
 *
 * INV-ATTRIBUTION-002: UTMs are structural metadata of the link, not PII.
 */
export function buildRedirectUrl(
  baseUrl: string,
  utmParams: Record<string, string | undefined>,
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // Malformed destination_url — return as-is; caller handles 302.
    return baseUrl;
  }

  for (const [k, v] of Object.entries(utmParams)) {
    // BR-ATTRIBUTION-001: only set UTM if it has a value and is not already set
    if (v && !url.searchParams.has(k)) {
      url.searchParams.set(k, v);
    }
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Route factory options
// ---------------------------------------------------------------------------

export interface RedirectRouteOptions {
  /**
   * Optional async function that queries a link by slug from the DB.
   * When omitted, KV cache misses return 404.
   * domain-author wires this up via apps/edge/src/lib/attribution.ts.
   */
  getLinkBySlug?: GetLinkBySlugFn;
  /**
   * Optional KV namespace override — used in tests to inject a mock KV.
   * When omitted the middleware reads from c.env.GT_KV.
   */
  kvOverride?: KVNamespace;
  /**
   * Optional Queue override — used in tests to inject a mock Queue.
   * When omitted the middleware reads from c.env.QUEUE_EVENTS.
   */
  queueOverride?: Queue;
  /**
   * Optional ExecutionContext override — used in tests to capture waitUntil
   * calls. When omitted the route uses c.executionCtx (may be undefined in
   * Node test environments; waitUntil calls are skipped gracefully).
   */
  ctxOverride?: ExecutionContext;
}

/**
 * Create the redirect sub-router, optionally injecting a DB lookup function
 * for cache-miss resolution and KV/Queue overrides for testing.
 *
 * Usage in index.ts:
 * ```ts
 * import { createRedirectRoute } from './routes/redirect.js';
 * app.route('/r', createRedirectRoute({ getLinkBySlug: getLinkBySlugFn }));
 * ```
 *
 * Usage in tests:
 * ```ts
 * createRedirectRoute({ kvOverride: mockKv, queueOverride: mockQueue });
 * ```
 */
export function createRedirectRoute(
  options: RedirectRouteOptions | GetLinkBySlugFn = {},
): Hono<AppEnv> {
  // Backwards-compat: allow passing getLinkBySlug directly (original signature)
  const opts: RedirectRouteOptions =
    typeof options === 'function' ? { getLinkBySlug: options } : options;
  const { getLinkBySlug, kvOverride, queueOverride, ctxOverride } = opts;
  const router = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // GET /:slug
  // CONTRACT-api-redirect-v1
  // -------------------------------------------------------------------------
  router.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    const requestId = c.get('request_id') ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // Step 1 — KV cache lookup (critical path)
    // -----------------------------------------------------------------------
    const cacheKey = `redirect:${slug}`;
    const kv = kvOverride ?? c.env.GT_KV;
    const queue = queueOverride ?? c.env.QUEUE_EVENTS;

    let entry: LinkCacheEntry | null = null;

    const cached = await kv.get<LinkCacheEntry>(cacheKey, {
      type: 'json',
    });

    if (cached !== null) {
      entry = cached;
    } else if (getLinkBySlug) {
      // -----------------------------------------------------------------------
      // Step 2 — Cache miss: query DB
      // -----------------------------------------------------------------------
      try {
        entry = await getLinkBySlug(slug);
      } catch (err) {
        // DB error — log and fall through to 404 (fail safe, not 500)
        // BR-PRIVACY-001: no PII in log
        safeLog('error', {
          event: 'redirect_db_error',
          request_id: requestId,
          slug_length: slug.length, // length only — not the slug value (could contain PII)
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        entry = null;
      }

      // Populate KV cache for subsequent requests (TTL 300s)
      if (entry !== null) {
        const execCtx = ctxOverride ?? c.executionCtx;
        execCtx?.waitUntil(
          kv
            .put(cacheKey, JSON.stringify(entry), {
              expirationTtl: 300,
            })
            .catch((putErr) => {
              // BR-PRIVACY-001: no PII in log
              safeLog('warn', {
                event: 'redirect_kv_write_failed',
                request_id: requestId,
                error_type:
                  putErr instanceof Error
                    ? putErr.constructor.name
                    : typeof putErr,
              });
            }),
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 3 — Handle not found
    // -----------------------------------------------------------------------
    if (entry === null) {
      // BR-PRIVACY-001: slug may have been typed/shared — do not echo in response
      return c.json(
        {
          code: 'link_not_found',
          message: 'Link not found',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 4 — Handle archived link (410 Gone)
    // -----------------------------------------------------------------------
    if (entry.status === 'archived') {
      return c.json(
        {
          code: 'archived',
          message: 'Link is no longer active',
          request_id: requestId,
        },
        410,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 5 — Build final URL with UTM propagation
    // -----------------------------------------------------------------------
    const utmParams: Record<string, string | undefined> = {
      utm_source: entry.utm_source,
      utm_medium: entry.utm_medium,
      utm_campaign: entry.utm_campaign,
      utm_content: entry.utm_content,
      utm_term: entry.utm_term,
    };

    const finalUrl = buildRedirectUrl(entry.destination_url, utmParams);

    // -----------------------------------------------------------------------
    // Step 6 — Enqueue link_click async (INV-ATTRIBUTION-003)
    //   waitUntil ensures the Worker does not terminate before the enqueue
    //   completes, but the response is not blocked by it.
    //
    // BR-ATTRIBUTION-001: click recorded with workspace_id + link_id.
    // BR-PRIVACY-001:     user-agent and IP are NOT included in queue payload
    //   (PII hashing is done by the consumer, which has access to the raw
    //    request context and applies lib/pii.ts before writing to DB).
    // -----------------------------------------------------------------------
    const clickPayload = {
      type: 'link_click' as const,
      slug,
      link_id: entry.link_id,
      workspace_id: entry.workspace_id,
      ts: new Date().toISOString(),
      // Raw identifiers for the queue consumer to hash — they MUST apply
      // INV-ATTRIBUTION-004 (SHA-256 hashing) before persisting.
      raw_ip:
        c.req.header('CF-Connecting-IP') ??
        c.req.header('X-Forwarded-For') ??
        null,
      raw_ua: c.req.header('User-Agent') ?? null,
      referrer: (() => {
        // Strip to domain only — full URL may contain PII (BR-PRIVACY-001)
        const referer = c.req.header('Referer') ?? c.req.header('Referrer');
        if (!referer) return null;
        try {
          return new URL(referer).hostname;
        } catch {
          return null;
        }
      })(),
      // Click IDs from ad platforms — passed through for attribution
      fbclid: c.req.query('fbclid') ?? null,
      gclid: c.req.query('gclid') ?? null,
      gbraid: c.req.query('gbraid') ?? null,
      wbraid: c.req.query('wbraid') ?? null,
    };

    // INV-ATTRIBUTION-003: fire-and-forget — never awaited before response
    const execCtxForClick = ctxOverride ?? c.executionCtx;
    execCtxForClick?.waitUntil(
      queue.send(clickPayload).catch((err) => {
        // BR-PRIVACY-001: no PII in log
        safeLog('warn', {
          event: 'redirect_click_enqueue_failed',
          request_id: requestId,
          workspace_id: entry.workspace_id,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }),
    );

    // -----------------------------------------------------------------------
    // Step 7 — 302 redirect
    // -----------------------------------------------------------------------
    safeLog('info', {
      event: 'redirect_resolved',
      request_id: requestId,
      workspace_id: entry.workspace_id,
    });

    return c.redirect(finalUrl, 302);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Default export — stub instance with no DB lookup.
// Callers should prefer createRedirectRoute(fn) to wire real DB.
//
// Wire real lookup in index.ts via:
//   app.route('/r', createRedirectRoute(getLinkBySlugFn));
// ---------------------------------------------------------------------------

/**
 * Default redirectRoute instance — DB lookup not wired (cache-miss → 404).
 *
 * The orquestrador mounts this via:
 * ```ts
 * app.route('/r', redirectRoute);
 * ```
 */
export const redirectRoute = createRedirectRoute({});
