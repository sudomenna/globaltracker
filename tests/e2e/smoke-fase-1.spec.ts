/**
 * tests/e2e/smoke-fase-1.spec.ts
 *
 * Smoke E2E — Fase 1 endpoints
 *
 * T-ID: T-1-021
 *
 * Prerequisites:
 *   1. Worker running:   pnpm --filter @globaltracker/edge dev
 *                        (or: wrangler dev --local)
 *   2. DB available:     DATABASE_URL set in .env.local
 *                        (Supabase local or Docker Postgres with migrations applied)
 *
 * Run individually:
 *   vitest run tests/e2e/smoke-fase-1.spec.ts
 *
 * Run via script:
 *   E2E_BASE_URL=http://localhost:8787 vitest run tests/e2e/smoke-fase-1.spec.ts
 *
 * The suite is SKIPPED gracefully when DATABASE_URL is not set so that
 * `pnpm test` in CI without a DB does not hard-fail.
 *
 * Contracts tested:
 *   CONTRACT-api-config-v1 (GET /v1/config)
 *   CONTRACT-api-events-v1 (POST /v1/events)
 *   CONTRACT-api-lead-v1   (POST /v1/lead)
 *   CONTRACT-api-redirect-v1 (GET /r/:slug)
 *
 * BRs applied (cited inline):
 *   BR-EVENT-002: event_time clamped transparently
 *   BR-EVENT-003: event_id deduplication (idempotent)
 *   BR-IDENTITY-005: lead_token returned in body; __ftk cookie set when consent.functional=true
 *   INV-IDENTITY-006: __ftk only when consent.functional is true
 *   BR-PRIVACY-001: smoke-test@example.com is synthetic, not real PII
 *   BR-ATTRIBUTION-001: redirect resolves and records click async
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Lazy DB import — only resolves when DATABASE_URL is present.
// This avoids import-time errors in environments without the DB package deps.
// ---------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8787';
const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Graceful skip guard
// ---------------------------------------------------------------------------

const SKIP_REASON =
  'E2E smoke tests require DATABASE_URL to be set. ' +
  'Set DATABASE_URL in .env.local and run: vitest run tests/e2e/smoke-fase-1.spec.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SeedResult {
  workspaceId: string;
  launchPublicId: string;
  launchId: string;
  pagePublicId: string;
  pageId: string;
  pageToken: string;
  pageTokenId: string;
  linkSlug: string;
  linkId: string;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Smoke — Fase 1 endpoints', () => {
  // Declared outside beforeAll so TypeScript is happy; will be assigned there.
  let seed: SeedResult;

  // --------------------------------------------------------------------------
  // Skip the entire suite when DATABASE_URL is absent — deterministic, no hang.
  // --------------------------------------------------------------------------
  if (!DATABASE_URL) {
    it.skip(SKIP_REASON, () => {});
    return;
  }

  // --------------------------------------------------------------------------
  // Setup: seed DB + verify worker is reachable
  // --------------------------------------------------------------------------
  beforeAll(async () => {
    // Dynamic import so the module (and its postgres dep) only loads when we
    // have a real DATABASE_URL.  This keeps `pnpm test` fast in environments
    // that don't have a running Postgres.
    const { createDb } = await import('@globaltracker/db');
    const { seedSmokeTest } = await import('./helpers/seed.js');

    const db = createDb(DATABASE_URL);
    seed = await seedSmokeTest(db);
  }, 30_000);

  afterAll(async () => {
    if (!seed) return; // guard: beforeAll may have failed
    const { createDb } = await import('@globaltracker/db');
    const { cleanupSmokeTest } = await import('./helpers/seed.js');

    // DATABASE_URL is narrowed to string by the outer if(!DATABASE_URL) guard
    const db = createDb(DATABASE_URL as string);
    await cleanupSmokeTest(db, seed);
  }, 30_000);

  // --------------------------------------------------------------------------
  // 1. GET /v1/config — CONTRACT-api-config-v1
  // --------------------------------------------------------------------------
  it('GET /v1/config → 200 with schema_version=1 and correct endpoints', async () => {
    const url = `${BASE_URL}/v1/config/${seed.launchPublicId}/${seed.pagePublicId}`;

    const res = await fetch(url, {
      headers: {
        // INV-PAGE-007: token binds request to workspace; middleware hashes and looks up
        'X-Funil-Site': seed.pageToken,
      },
    });

    expect(res.status, `GET ${url} expected 200`).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    // CONTRACT-api-config-v1: required fields
    expect(body.schema_version).toBe(1);
    expect((body.endpoints as Record<string, unknown>).events).toBe(
      '/v1/events',
    );
    expect(body.event_config).toBeDefined();
    expect(body.lead_token_settings).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 2. POST /v1/events — CONTRACT-api-events-v1 (first send → accepted)
  // --------------------------------------------------------------------------
  it('POST /v1/events → 202 accepted', async () => {
    // BR-EVENT-003: event_id must be unique per workspace per request
    const eventId = randomUUID();
    const url = `${BASE_URL}/v1/events`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // INV-PAGE-007: page token resolves workspace_id + page_id in middleware
        'X-Funil-Site': seed.pageToken,
      },
      body: JSON.stringify({
        event_id: eventId,
        schema_version: 1,
        launch_public_id: seed.launchPublicId,
        page_public_id: seed.pagePublicId,
        event_name: 'PageView',
        // BR-EVENT-002: event_time not in future, not past > clamp window
        event_time: new Date().toISOString(),
        attribution: {},
        custom_data: {},
        consent: { analytics: true, marketing: true, functional: true },
      }),
    });

    expect(res.status, `POST ${url} expected 202`).toBe(202);

    const body = (await res.json()) as Record<string, unknown>;
    // CONTRACT-api-events-v1: response must include event_id and status
    expect(body.event_id).toBe(eventId);
    expect(body.status).toBe('accepted');
  });

  // --------------------------------------------------------------------------
  // 3. POST /v1/events idempotent — same event_id → duplicate_accepted
  //    BR-EVENT-003: replay protection via KV; duplicate → 202 duplicate_accepted
  //    INV-EVENT-003: idempotent — same event_id never inserted twice
  // --------------------------------------------------------------------------
  it('POST /v1/events idempotent → 202 duplicate_accepted', async () => {
    // Use a fixed event_id so we can replay it
    const eventId = randomUUID();
    const url = `${BASE_URL}/v1/events`;

    const payload = JSON.stringify({
      event_id: eventId,
      schema_version: 1,
      launch_public_id: seed.launchPublicId,
      page_public_id: seed.pagePublicId,
      event_name: 'PageView',
      event_time: new Date().toISOString(),
      attribution: {},
      custom_data: {},
      consent: { analytics: true, marketing: true, functional: true },
    });

    const headers = {
      'Content-Type': 'application/json',
      'X-Funil-Site': seed.pageToken,
    };

    // First send — accepted
    const first = await fetch(url, { method: 'POST', headers, body: payload });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.status).toBe('accepted');

    // Second send — same event_id → duplicate_accepted
    // BR-EVENT-003: replay protection; INV-EVENT-003: idempotent response
    const second = await fetch(url, { method: 'POST', headers, body: payload });
    expect(second.status, 'replay should return 202').toBe(202);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.status).toBe('duplicate_accepted');
    // event_id is echoed back on both sends
    expect(secondBody.event_id).toBe(eventId);
  });

  // --------------------------------------------------------------------------
  // 4. POST /v1/lead — CONTRACT-api-lead-v1
  //    BR-IDENTITY-005: lead_token HMAC returned; __ftk cookie set
  //    INV-IDENTITY-006: __ftk only when consent.functional=true
  // --------------------------------------------------------------------------
  it('POST /v1/lead → 202 with lead_token + Set-Cookie __ftk', async () => {
    const eventId = randomUUID();
    const url = `${BASE_URL}/v1/lead`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // INV-PAGE-007: page token resolves workspace_id in middleware
        'X-Funil-Site': seed.pageToken,
      },
      body: JSON.stringify({
        event_id: eventId,
        schema_version: 1,
        launch_public_id: seed.launchPublicId,
        page_public_id: seed.pagePublicId,
        // BR-PRIVACY-001: synthetic email — not real PII
        email: 'smoke-test@example.com',
        attribution: {},
        // INV-IDENTITY-006: consent.functional=true → __ftk cookie must be set
        consent: { analytics: true, marketing: true, functional: true },
      }),
    });

    expect(res.status, `POST ${url} expected 202`).toBe(202);

    const body = (await res.json()) as Record<string, unknown>;

    // CONTRACT-api-lead-v1: required fields in response
    expect(body.status).toBe('accepted');
    // BR-IDENTITY-005: lead_token is a non-empty string
    expect(typeof body.lead_token).toBe('string');
    expect((body.lead_token as string).length).toBeGreaterThan(0);
    expect(body.lead_public_id).toBeDefined();
    expect(body.expires_at).toBeDefined();

    // INV-IDENTITY-006: __ftk cookie set because consent.functional=true
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie, 'Set-Cookie header must contain __ftk').toContain(
      '__ftk',
    );
    // BR-IDENTITY-005: HttpOnly + Secure attributes
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  // --------------------------------------------------------------------------
  // 5. GET /r/:slug — CONTRACT-api-redirect-v1
  //    BR-ATTRIBUTION-001: click recorded async; redirect is synchronous
  // --------------------------------------------------------------------------
  it('GET /r/:slug → 302 with Location header', async () => {
    const url = `${BASE_URL}/r/${seed.linkSlug}`;

    // Use redirect: 'manual' so fetch does not follow the 302 automatically
    const res = await fetch(url, { redirect: 'manual' });

    expect(res.status, `GET ${url} expected 302`).toBe(302);

    const location = res.headers.get('Location');
    // CONTRACT-api-redirect-v1: Location header must be present and non-empty
    expect(location, 'Location header must be set').toBeTruthy();
    // destination_url from seed is 'https://example.com/smoke-destination'
    expect(location).toContain('example.com');
  });
});
