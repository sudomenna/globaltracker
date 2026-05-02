/**
 * apps/edge/src/index.ts — Cloudflare Worker entry point (Hono).
 *
 * Middleware chain (applied in order):
 *   sanitize-logs  → sets request_id, logs safe fields, ensures X-Request-Id on response
 *   auth-public-token (per route group) → sets workspace_id + page_id in context
 *   cors (per route group) → validates Origin against allowed_domains
 *   rate-limit (per route group) → sliding window via KV
 *   → handler
 *
 * Public routes (/v1/events, /v1/lead, /v1/config):
 *   Auth header: X-Funil-Site (page_token)
 *   Rate limit: route-specific limits
 *
 * Health route (/health): no auth, no rate limit.
 *
 * BR-PRIVACY-001: sanitize-logs applied globally — zero PII in log output.
 * INV-PAGE-007: auth-public-token enforces workspace isolation per token.
 */

import { Hono } from 'hono';
import {
  type LookupPageTokenFn,
  authPublicToken,
} from './middleware/auth-public-token.js';
import { type GetAllowedDomainsFn, corsMiddleware } from './middleware/cors.js';
import { rateLimit } from './middleware/rate-limit.js';
import { sanitizeLogs } from './middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  /** Hyperdrive binding for DB access — injected in production. */
  DB?: Fetcher;
};

// ---------------------------------------------------------------------------
// Context variables
// ---------------------------------------------------------------------------

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Global middleware (all routes)
// BR-PRIVACY-001: sanitize-logs applied globally — ensures X-Request-Id + safe logs
// ---------------------------------------------------------------------------
app.use('*', sanitizeLogs());

// ---------------------------------------------------------------------------
// Health check — no auth, no rate limit
// ---------------------------------------------------------------------------
app.get('/health', (c) => {
  return c.json({ status: 'ok', environment: c.env.ENVIRONMENT });
});

// ---------------------------------------------------------------------------
// Public routes — /v1/* (tracker.js endpoints)
//
// NOTE: In Sprint 1 these stubs accept requests after middleware validation.
// Route handlers for /v1/events, /v1/lead, /v1/config will be added in
// subsequent T-IDs by domain-author and edge-author.
//
// Middleware order: auth → cors → rate-limit → handler
// ---------------------------------------------------------------------------

/**
 * Lookup function for page_tokens — queries DB by token_hash.
 * In production this will query via Hyperdrive; stub returns null for now.
 *
 * domain-author implements: apps/edge/src/lib/page-token.ts → getPageByToken()
 */
const lookupPageToken: LookupPageTokenFn = async (_tokenHash) => {
  // TODO(T-1-domain): wire up apps/edge/src/lib/page-token.ts → getPageByToken()
  return null;
};

/**
 * Get allowed domains for a page — queried from DB by page_id.
 * domain-author implements: apps/edge/src/lib/page.ts → getPageById()
 */
const getAllowedDomains: GetAllowedDomainsFn = async (_pageId) => {
  // TODO(T-1-domain): wire up apps/edge/src/lib/page.ts → getPageById().allowedDomains
  return [];
};

// /v1/events — 100 req/min/workspace
app.post(
  '/v1/events',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'events' }),
  (c) => {
    // Stub — handler implemented by edge-author in T-1-016 / T-1-017
    const requestId = c.get('request_id');
    return c.json({ status: 'stub', request_id: requestId }, 202);
  },
);

// /v1/lead — 20 req/min/workspace
app.post(
  '/v1/lead',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'lead' }),
  (c) => {
    // Stub — handler implemented by edge-author
    const requestId = c.get('request_id');
    return c.json({ status: 'stub', request_id: requestId }, 202);
  },
);

// /v1/config — 60 req/min/workspace (accepts rotating tokens too)
app.get(
  '/v1/config/:launch_public_id/:page_public_id',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'config' }),
  (c) => {
    // Stub — handler implemented by edge-author
    const requestId = c.get('request_id');
    return c.json({ status: 'stub', request_id: requestId }, 200);
  },
);

// OPTIONS preflight for public routes — handled by CORS middleware
// Hono needs an explicit OPTIONS handler per path or a wildcard
app.options(
  '/v1/*',
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  () => {
    return new Response(null, { status: 204 });
  },
);

export default app;
