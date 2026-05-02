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
import { adminLeadsEraseRoute } from './routes/admin/leads-erase.js';
import { configRoute } from './routes/config.js';
import { eventsRoute } from './routes/events.js';
import { leadRoute } from './routes/lead.js';
import { redirectRoute } from './routes/redirect.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  HYPERDRIVE: Hyperdrive;
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

// ---------------------------------------------------------------------------
// Public route middleware — applied before sub-router handlers via .use()
// Middleware order per path: auth → cors → rate-limit
// ---------------------------------------------------------------------------

app.use(
  '/v1/events',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'events' }),
);
app.use(
  '/v1/lead',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'lead' }),
);
app.use(
  '/v1/config/*',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'config' }),
);

// OPTIONS preflight — must be before route mounts so CORS headers are set
app.options(
  '/v1/*',
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  () => new Response(null, { status: 204 }),
);

// ---------------------------------------------------------------------------
// Route mounts — sub-routers registered by T-1-016..T-1-020
// ---------------------------------------------------------------------------

app.route('/v1/events', eventsRoute);
app.route('/v1/lead', leadRoute);
app.route('/v1/config', configRoute);
app.route('/r', redirectRoute);
app.route('/v1/admin/leads', adminLeadsEraseRoute);

export default app;
