/**
 * tests/e2e/helpers/seed.ts
 *
 * Seed + cleanup helpers for E2E smoke tests.
 *
 * Creates: workspace → launch → page → page_token → link
 *
 * T-ID: T-1-021
 *
 * Token strategy (matches auth-public-token.ts middleware):
 *   BR-PRIVACY-002: clear token is used in X-Funil-Site header by tests;
 *   SHA-256(token) is stored in page_tokens.token_hash.
 *   INV-PAGE-003: token_hash is globally unique.
 *
 * No PII — all identifiers are synthetic/random.
 */

import crypto from 'node:crypto';
import {
  type Db,
  launches,
  links,
  pageTokens,
  pages,
  workspaces,
} from '@globaltracker/db';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SeedResult {
  /** Internal workspace UUID — used for cleanup queries. */
  workspaceId: string;
  /** Public ID of the launch — sent in POST /v1/events and /v1/lead bodies. */
  launchPublicId: string;
  /** Internal launch UUID — used for cleanup. */
  launchId: string;
  /** Public ID of the page — sent in POST bodies and GET /v1/config path. */
  pagePublicId: string;
  /** Internal page UUID — used for cleanup. */
  pageId: string;
  /** Clear token — set as X-Funil-Site header in test requests. */
  pageToken: string;
  /** Internal page_token UUID — used for cleanup. */
  pageTokenId: string;
  /** Link slug for GET /r/:slug test. */
  linkSlug: string;
  /** Internal link UUID — used for cleanup. */
  linkId: string;
}

// ---------------------------------------------------------------------------
// SHA-256 helper — matches auth-public-token.ts hashToken()
// ---------------------------------------------------------------------------

/**
 * Return hex SHA-256 of a UTF-8 string.
 * BR-PRIVACY-002: clear token never stored; only hash persisted.
 */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Seed the DB with the minimal graph needed for Fase 1 smoke tests.
 *
 * All slugs/public-IDs include a random suffix so parallel test runs do not
 * collide on unique constraints.
 */
export async function seedSmokeTest(db: Db): Promise<SeedResult> {
  // Suffix to avoid collisions across test runs (deterministic within a run)
  const suffix = crypto.randomBytes(4).toString('hex');

  // -------------------------------------------------------------------------
  // 1. Workspace
  // -------------------------------------------------------------------------
  const [workspace] = await db
    .insert(workspaces)
    .values({
      slug: `smoke-ws-${suffix}`,
      name: `Smoke Workspace ${suffix}`,
      status: 'active',
    })
    .returning({ id: workspaces.id });

  if (!workspace) throw new Error('seed: workspace insert returned no rows');
  const workspaceId = workspace.id;

  // -------------------------------------------------------------------------
  // 2. Launch
  // -------------------------------------------------------------------------
  const launchPublicId = `smoke-launch-${suffix}`;

  const [launch] = await db
    .insert(launches)
    .values({
      workspaceId,
      publicId: launchPublicId,
      name: `Smoke Launch ${suffix}`,
      status: 'live',
      timezone: 'America/Sao_Paulo',
      config: {},
    })
    .returning({ id: launches.id });

  if (!launch) throw new Error('seed: launch insert returned no rows');
  const launchId = launch.id;

  // -------------------------------------------------------------------------
  // 3. Page
  // -------------------------------------------------------------------------
  const pagePublicId = `smoke-page-${suffix}`;

  const [page] = await db
    .insert(pages)
    .values({
      workspaceId,
      launchId,
      publicId: pagePublicId,
      role: 'capture',
      integrationMode: 'b_snippet',
      status: 'active',
      // INV-PAGE-002: allowed_domains must not be empty for b_snippet mode
      allowedDomains: ['localhost', '127.0.0.1'],
      eventConfig: {
        pixel_policy: 'browser_and_server_managed',
        allowed_event_names: ['PageView', 'Lead'],
        custom_data_schema: {},
      },
    })
    .returning({ id: pages.id });

  if (!page) throw new Error('seed: page insert returned no rows');
  const pageId = page.id;

  // -------------------------------------------------------------------------
  // 4. Page token
  //    BR-PRIVACY-002: clear token in memory; SHA-256 hash stored in DB.
  //    INV-PAGE-003: token_hash is globally unique.
  // -------------------------------------------------------------------------
  const pageToken = crypto.randomUUID(); // clear token used in X-Funil-Site header
  const tokenHash = sha256Hex(pageToken); // 64-char hex stored in DB

  const [pageTokenRow] = await db
    .insert(pageTokens)
    .values({
      workspaceId,
      pageId,
      tokenHash,
      label: `smoke-token-${suffix}`,
      status: 'active',
    })
    .returning({ id: pageTokens.id });

  if (!pageTokenRow)
    throw new Error('seed: page_token insert returned no rows');
  const pageTokenId = pageTokenRow.id;

  // -------------------------------------------------------------------------
  // 5. Link (for GET /r/:slug test)
  //    BR-ATTRIBUTION-003: slug is globally unique.
  // -------------------------------------------------------------------------
  const linkSlug = `smoke-${suffix}`;

  const [link] = await db
    .insert(links)
    .values({
      workspaceId,
      launchId,
      slug: linkSlug,
      destinationUrl: 'https://example.com/smoke-destination',
      status: 'active',
    })
    .returning({ id: links.id });

  if (!link) throw new Error('seed: link insert returned no rows');
  const linkId = link.id;

  return {
    workspaceId,
    launchPublicId,
    launchId,
    pagePublicId,
    pageId,
    pageToken,
    pageTokenId,
    linkSlug,
    linkId,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove all rows inserted by seedSmokeTest in reverse FK order.
 *
 * Each test suite is responsible for calling this in afterAll to avoid
 * leaking state into subsequent runs.
 */
export async function cleanupSmokeTest(
  db: Db,
  seed: SeedResult,
): Promise<void> {
  // Delete in reverse FK order to avoid constraint violations.
  // links → page_tokens → pages → launches → workspaces

  await db.delete(links).where(eq(links.id, seed.linkId));
  await db.delete(pageTokens).where(eq(pageTokens.id, seed.pageTokenId));
  await db.delete(pages).where(eq(pages.id, seed.pageId));
  await db.delete(launches).where(eq(launches.id, seed.launchId));
  await db.delete(workspaces).where(eq(workspaces.id, seed.workspaceId));
}
