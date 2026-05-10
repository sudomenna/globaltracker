/**
 * routes/meta-audiences.ts
 *
 * POST /v1/launches/:public_id/meta-audiences/sync
 *   Auth: JWT — role OPERATOR or ADMIN (or above)
 *   Reads Meta Ads campaigns filtered by launch.config.metaCampaignPrefix,
 *   extracts all Custom Audience IDs referenced in ad-set targeting, fetches
 *   audience metadata in a single batch call, then upserts into meta_audiences.
 *
 * GET /v1/launches/:public_id/meta-audiences
 *   Auth: JWT — any authenticated workspace member
 *   Returns the cached audiences for the launch, ordered by subtype then name.
 *
 * Model "read-heavy cache" (ADR-004 variant):
 *   POST /sync is intentionally synchronous (user triggered, low frequency).
 *   Latency budget: up to ~10 s for campaigns with many ad-sets; CF Workers
 *   timeout is 30 s on paid plan.
 *
 * BR-PRIVACY-001: zero PII in logs or error responses.
 * BR-RBAC-001: workspace_id resolved from JWT membership, never request body.
 * BR-RBAC-002: OPERATOR or ADMIN required to trigger sync; any member can GET.
 * INV-META-AUDIENCE-001: upsert is idempotent — ON CONFLICT (workspace_id,
 *   launch_id, meta_audience_id) DO UPDATE ensures safety on retry.
 */

import {
  createDb,
  launches,
  metaAudiences,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { isValidRole, type WorkspaceRole } from '../lib/rbac.js';
import {
  supabaseJwtMiddleware,
  type LookupWorkspaceMemberFn,
} from '../middleware/auth-supabase-jwt.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env / context types (mirrored from leads-summary pattern)
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  SUPABASE_URL?: string;
  META_ADS_ACCESS_TOKEN: string;
  META_ADS_ACCOUNT_ID: string;
};

type AppVariables = {
  workspace_id?: string;
  request_id?: string;
  role?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Meta API constants
// ---------------------------------------------------------------------------

const META_API_VERSION = 'v21.0';
const META_API_BASE = 'https://graph.facebook.com';

// ---------------------------------------------------------------------------
// Zod — Meta API response schemas (passthrough so extra fields are ignored)
// ---------------------------------------------------------------------------

const MetaCampaignSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

const MetaCampaignsPageSchema = z.object({
  data: z.array(MetaCampaignSchema),
  paging: z
    .object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() })
    .optional(),
});

const MetaAudienceRefSchema = z
  .object({ id: z.string() })
  .passthrough();

const MetaTargetingSchema = z
  .object({
    custom_audiences: z.array(MetaAudienceRefSchema).optional(),
    excluded_custom_audiences: z.array(MetaAudienceRefSchema).optional(),
  })
  .passthrough();

const MetaAdSetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    targeting: MetaTargetingSchema.optional(),
  })
  .passthrough();

const MetaAdSetsPageSchema = z.object({
  data: z.array(MetaAdSetSchema),
  paging: z
    .object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() })
    .optional(),
});

const MetaAudienceDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    subtype: z.string(),
    approximate_count_upper_bound: z.number().optional(),
    delivery_status: z
      .object({
        code: z.number().optional(),
        description: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

// Batch response: { "<id>": { ... } }
const MetaAudienceBatchResponseSchema = z.record(
  z.string(),
  MetaAudienceDetailSchema.nullable(),
);

// ---------------------------------------------------------------------------
// Zod — GET response schema
// ---------------------------------------------------------------------------

const AudienceItemSchema = z
  .object({
    id: z.string(),
    meta_audience_id: z.string(),
    name: z.string(),
    subtype: z.enum(['CUSTOM', 'WEBSITE', 'LOOKALIKE', 'IG_BUSINESS']),
    approx_count: z.number().nullable(),
    delivery_status_code: z.number().nullable(),
    delivery_status_description: z.string().nullable(),
    synced_at: z.string(),
  })
  .strict();

export const metaAudiencesResponseSchema = z
  .object({
    audiences: z.array(AudienceItemSchema),
    last_synced_at: z.string().nullable(),
  })
  .strict();

export type MetaAudiencesResponse = z.infer<typeof metaAudiencesResponseSchema>;

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

/** Roles allowed to trigger a sync. */
const SYNC_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
  'owner',
  'admin',
  'operator',
]);

function canSync(role: string | undefined): boolean {
  return typeof role === 'string' && SYNC_ROLES.has(role as WorkspaceRole);
}

// ---------------------------------------------------------------------------
// Meta API helpers (fetch-injectable for testability)
// ---------------------------------------------------------------------------

/**
 * Fetch all campaigns for an account whose name starts with `prefix`.
 * Paginates via cursor until exhausted.
 *
 * @throws on network error or non-2xx HTTP from Meta.
 */
async function fetchCampaignsByPrefix(
  accountId: string,
  accessToken: string,
  prefix: string,
  fetchFn: typeof fetch = fetch,
): Promise<Array<{ id: string; name: string }>> {
  const results: Array<{ id: string; name: string }> = [];

  const baseParams = new URLSearchParams({
    fields: 'id,name',
    limit: '50',
    access_token: accessToken,
  });

  let url: string | null =
    `${META_API_BASE}/${META_API_VERSION}/act_${accountId}/campaigns?${baseParams.toString()}`;

  while (url !== null) {
    const resp = await fetchFn(url);
    if (!resp.ok) {
      throw new Error(`Meta campaigns API returned HTTP ${resp.status}`);
    }
    const body: unknown = await resp.json();
    const parsed = MetaCampaignsPageSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Unexpected Meta campaigns response shape`);
    }

    for (const c of parsed.data.data) {
      if (c.name.startsWith(prefix)) {
        results.push({ id: c.id, name: c.name });
      }
    }

    url = parsed.data.paging?.next ?? null;
  }

  return results;
}

/**
 * Fetch all ad-sets for a single campaign, returning only the `targeting` field.
 * Errors for a single campaign are caught by the caller.
 */
async function fetchAdSetTargetings(
  campaignId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<Array<{ custom_audiences?: Array<{ id: string }>; excluded_custom_audiences?: Array<{ id: string }> }>> {
  const results: Array<{
    custom_audiences?: Array<{ id: string }>;
    excluded_custom_audiences?: Array<{ id: string }>;
  }> = [];

  const baseParams = new URLSearchParams({
    fields: 'id,name,targeting',
    limit: '50',
    access_token: accessToken,
  });

  let url: string | null =
    `${META_API_BASE}/${META_API_VERSION}/${campaignId}/adsets?${baseParams.toString()}`;

  while (url !== null) {
    const resp = await fetchFn(url);
    if (!resp.ok) {
      throw new Error(
        `Meta adsets API returned HTTP ${resp.status} for campaign ${campaignId}`,
      );
    }
    const body: unknown = await resp.json();
    const parsed = MetaAdSetsPageSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Unexpected Meta adsets response for campaign ${campaignId}`);
    }

    for (const adSet of parsed.data.data) {
      if (adSet.targeting) {
        results.push({
          custom_audiences: adSet.targeting.custom_audiences?.map((a) => ({ id: a.id })),
          excluded_custom_audiences: adSet.targeting.excluded_custom_audiences?.map((a) => ({ id: a.id })),
        });
      }
    }

    url = parsed.data.paging?.next ?? null;
  }

  return results;
}

/**
 * Batch-fetch audience metadata for up to N IDs in a single Meta API call.
 *
 * Uses the batch node endpoint:
 *   GET /v21.0/?ids=ID1,ID2,ID3&fields=id,name,subtype,...&access_token=TOKEN
 *
 * Returns a map audienceId → detail (null if Meta returned null for that ID).
 */
async function fetchAudiencesBatch(
  audienceIds: string[],
  accountId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<
  Map<
    string,
    {
      id: string;
      name: string;
      subtype: string;
      approx_count: number | null;
      delivery_status_code: number | null;
      delivery_status_description: string | null;
    }
  >
> {
  const result = new Map<
    string,
    {
      id: string;
      name: string;
      subtype: string;
      approx_count: number | null;
      delivery_status_code: number | null;
      delivery_status_description: string | null;
    }
  >();

  if (audienceIds.length === 0) return result;

  // Process in chunks of 50 to respect Meta API limits on batch node requests.
  const CHUNK_SIZE = 50;
  for (let i = 0; i < audienceIds.length; i += CHUNK_SIZE) {
    const chunk = audienceIds.slice(i, i + CHUNK_SIZE);
    const params = new URLSearchParams({
      ids: chunk.join(','),
      fields:
        'id,name,subtype,approximate_count_upper_bound,delivery_status',
      access_token: accessToken,
    });

    const url = `${META_API_BASE}/${META_API_VERSION}/?${params.toString()}`;
    const resp = await fetchFn(url);
    if (!resp.ok) {
      throw new Error(`Meta batch audiences API returned HTTP ${resp.status}`);
    }

    const body: unknown = await resp.json();

    // Meta returns { data: [ {...}, ...] } from customaudiences endpoint
    // when querying with ?ids= — but when filtering by account audience list
    // it returns a data array. We handle the account's audience list shape.
    // Actually for batch by IDs the recommended endpoint returns a record shape
    // at the root node. Let's try to detect both.
    let rows: unknown[] = [];

    // If body is { data: [...] } (customaudiences list format)
    if (
      body !== null &&
      typeof body === 'object' &&
      'data' in (body as object) &&
      Array.isArray((body as { data: unknown }).data)
    ) {
      rows = (body as { data: unknown[] }).data;
    }
    // If body is { "id1": {...}, "id2": {...} } (batch node format)
    else if (body !== null && typeof body === 'object') {
      rows = Object.values(body as Record<string, unknown>);
    }

    for (const row of rows) {
      const parsed = MetaAudienceDetailSchema.safeParse(row);
      if (!parsed.success || parsed.data === null) continue;
      const d = parsed.data;
      result.set(d.id, {
        id: d.id,
        name: d.name,
        subtype: d.subtype,
        approx_count: d.approximate_count_upper_bound ?? null,
        delivery_status_code: d.delivery_status?.code ?? null,
        delivery_status_description: d.delivery_status?.description ?? null,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export type CreateMetaAudiencesRouteOpts = {
  /** Connection string resolver */
  getConnStr: (env: AppBindings) => string;
  /** Optional injectable DB factory — for tests */
  buildDb?: (env: AppBindings) => Db;
  /** Optional injectable fetch — for tests */
  fetchFn?: typeof fetch;
};

export function createMetaAudiencesRoute(
  opts: CreateMetaAudiencesRouteOpts,
): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveDb(env: AppBindings): Db {
    if (opts.buildDb) return opts.buildDb(env);
    return createDb(opts.getConnStr(env));
  }

  // -------------------------------------------------------------------------
  // Auth middleware — JWT verification + workspace_member lookup
  // -------------------------------------------------------------------------
  const buildLookupMember = (env: AppBindings): LookupWorkspaceMemberFn => {
    return async (userId: string) => {
      const connStr = opts.getConnStr(env);
      if (!connStr) return null;
      const db = createDb(connStr);
      const rows = await db
        .select({
          workspace_id: workspaceMembers.workspaceId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);
      const row = rows[0];
      if (!row || !isValidRole(row.role)) return null;
      return { workspace_id: row.workspace_id, role: row.role };
    };
  };

  route.use('*', async (c, next) => {
    const mw = supabaseJwtMiddleware<AppEnv>({
      lookupMember: buildLookupMember(c.env),
    });
    return mw(c, next);
  });

  // -------------------------------------------------------------------------
  // POST /:public_id/meta-audiences/sync
  // -------------------------------------------------------------------------
  route.post('/:public_id/meta-audiences/sync', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json(
        { code: 'unauthorized', request_id: requestId },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // BR-RBAC-002: OPERATOR or ADMIN (or owner) required to trigger sync
    const role = c.get('role') as string | undefined;
    if (!canSync(role)) {
      return c.json(
        { code: 'forbidden', message: 'Role operator or admin required', request_id: requestId },
        403,
        { 'X-Request-Id': requestId },
      );
    }

    const publicId = c.req.param('public_id');
    if (!publicId || publicId.trim() === '') {
      return c.json(
        { code: 'validation_error', message: 'public_id is required', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);

    // -----------------------------------------------------------------------
    // 1. Resolve launch
    // -----------------------------------------------------------------------
    let launch: { id: string; config: unknown } | null = null;
    try {
      const rows = await db
        .select({ id: launches.id, config: launches.config })
        .from(launches)
        .where(
          and(
            eq(launches.publicId, publicId),
            eq(launches.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      launch = rows[0] ?? null;
    } catch (err) {
      safeLog('error', {
        event: 'meta_audiences_sync_db_error',
        request_id: requestId,
        step: 'resolve_launch',
        error: err instanceof Error ? err.message : 'unknown',
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    if (!launch) {
      return c.json(
        { code: 'launch_not_found', request_id: requestId },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 2. Extract metaCampaignPrefix — body takes precedence over launch.config
    // -----------------------------------------------------------------------
    let bodyPrefix: string | null = null;
    try {
      const body = await c.req.json<{ prefix?: unknown }>();
      if (typeof body?.prefix === 'string' && body.prefix.trim()) {
        bodyPrefix = body.prefix.trim();
      }
    } catch {
      // body is optional — ignore parse errors
    }

    const configRaw =
      typeof launch.config === 'string'
        ? (() => {
            try {
              return JSON.parse(launch.config) as Record<string, unknown>;
            } catch {
              return {} as Record<string, unknown>;
            }
          })()
        : (launch.config as Record<string, unknown> | null) ?? {};

    const metaCampaignPrefix =
      bodyPrefix ??
      (typeof configRaw.metaCampaignPrefix === 'string'
        ? configRaw.metaCampaignPrefix.trim()
        : null);

    if (!metaCampaignPrefix) {
      return c.json(
        {
          code: 'missing_config',
          message:
            'Informe o prefixo da campanha Meta (ex: "WCS-JUN26") no corpo da requisição ou em launch.config.metaCampaignPrefix.',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const { META_ADS_ACCESS_TOKEN, META_ADS_ACCOUNT_ID } = c.env;
    if (!META_ADS_ACCESS_TOKEN || !META_ADS_ACCOUNT_ID) {
      safeLog('error', {
        event: 'meta_audiences_sync_missing_env',
        request_id: requestId,
      });
      return c.json(
        { code: 'internal_error', message: 'Meta Ads credentials not configured', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    const fetchFn = opts.fetchFn ?? fetch;

    // -----------------------------------------------------------------------
    // 3. Fetch campaigns matching prefix
    // -----------------------------------------------------------------------
    let campaigns: Array<{ id: string; name: string }> = [];
    try {
      campaigns = await fetchCampaignsByPrefix(
        META_ADS_ACCOUNT_ID,
        META_ADS_ACCESS_TOKEN,
        metaCampaignPrefix,
        fetchFn,
      );
    } catch (err) {
      safeLog('error', {
        event: 'meta_audiences_sync_campaigns_error',
        request_id: requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return c.json(
        { code: 'meta_api_error', message: 'Failed to fetch Meta campaigns', request_id: requestId },
        502,
        { 'X-Request-Id': requestId },
      );
    }

    safeLog('info', {
      event: 'meta_audiences_sync_campaigns_fetched',
      request_id: requestId,
      campaigns_count: campaigns.length,
    });

    if (campaigns.length === 0) {
      return c.json(
        { synced: 0, launch_id: publicId, request_id: requestId },
        200,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 4. For each campaign, fetch ad-set targeting and collect audience IDs
    // -----------------------------------------------------------------------
    const audienceIdSet = new Set<string>();

    for (const campaign of campaigns) {
      try {
        const targetings = await fetchAdSetTargetings(
          campaign.id,
          META_ADS_ACCESS_TOKEN,
          fetchFn,
        );
        for (const t of targetings) {
          for (const a of t.custom_audiences ?? []) audienceIdSet.add(a.id);
          for (const a of t.excluded_custom_audiences ?? []) audienceIdSet.add(a.id);
        }
      } catch (err) {
        // Log and continue — one campaign failure should not abort the entire sync
        safeLog('warn', {
          event: 'meta_audiences_sync_adsets_error',
          request_id: requestId,
          campaign_id: campaign.id,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    const audienceIds = Array.from(audienceIdSet);

    safeLog('info', {
      event: 'meta_audiences_sync_audience_ids_collected',
      request_id: requestId,
      audience_ids_count: audienceIds.length,
    });

    if (audienceIds.length === 0) {
      return c.json(
        { synced: 0, launch_id: publicId, request_id: requestId },
        200,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 5. Batch-fetch audience metadata
    // -----------------------------------------------------------------------
    let audienceMap: Map<
      string,
      {
        id: string;
        name: string;
        subtype: string;
        approx_count: number | null;
        delivery_status_code: number | null;
        delivery_status_description: string | null;
      }
    >;

    try {
      audienceMap = await fetchAudiencesBatch(
        audienceIds,
        META_ADS_ACCOUNT_ID,
        META_ADS_ACCESS_TOKEN,
        fetchFn,
      );
    } catch (err) {
      safeLog('error', {
        event: 'meta_audiences_sync_batch_error',
        request_id: requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return c.json(
        { code: 'meta_api_error', message: 'Failed to fetch Meta audience metadata', request_id: requestId },
        502,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 6. Upsert into meta_audiences
    //    INV-META-AUDIENCE-001: ON CONFLICT (workspace_id, launch_id, meta_audience_id) DO UPDATE
    // -----------------------------------------------------------------------
    const now = new Date();
    const rows = Array.from(audienceMap.values()).map((a) => ({
      workspaceId,
      launchId: launch.id,
      metaAudienceId: a.id,
      name: a.name,
      subtype: a.subtype,
      approxCount: a.approx_count,
      deliveryStatusCode: a.delivery_status_code,
      deliveryStatusDescription: a.delivery_status_description,
      syncedAt: now,
    }));

    if (rows.length === 0) {
      return c.json(
        { synced: 0, launch_id: publicId, request_id: requestId },
        200,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      await db
        .insert(metaAudiences)
        .values(rows)
        .onConflictDoUpdate({
          // INV-META-AUDIENCE-001: idempotent upsert on natural key.
          // launch_id is always non-null here (resolved above) — the nullable
          // column in the schema is for ON DELETE SET NULL orphan retention only.
          // Postgres 15+ handles the non-null case correctly in UNIQUE conflicts.
          target: [
            metaAudiences.workspaceId,
            metaAudiences.launchId,
            metaAudiences.metaAudienceId,
          ],
          set: {
            name: sql`excluded.name`,
            subtype: sql`excluded.subtype`,
            approxCount: sql`excluded.approx_count`,
            deliveryStatusCode: sql`excluded.delivery_status_code`,
            deliveryStatusDescription: sql`excluded.delivery_status_description`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
    } catch (err) {
      safeLog('error', {
        event: 'meta_audiences_sync_upsert_error',
        request_id: requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    safeLog('info', {
      event: 'meta_audiences_sync_complete',
      request_id: requestId,
      synced: rows.length,
    });

    return c.json(
      { synced: rows.length, launch_id: publicId },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // GET /:public_id/meta-audiences
  // -------------------------------------------------------------------------
  route.get('/:public_id/meta-audiences', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json(
        { code: 'unauthorized', request_id: requestId },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const publicId = c.req.param('public_id');
    if (!publicId || publicId.trim() === '') {
      return c.json(
        { code: 'validation_error', message: 'public_id is required', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);

    // Resolve launch (workspace-scoped)
    let launchId: string | null = null;
    try {
      const rows = await db
        .select({ id: launches.id })
        .from(launches)
        .where(
          and(
            eq(launches.publicId, publicId),
            eq(launches.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      launchId = rows[0]?.id ?? null;
    } catch (err) {
      safeLog('error', {
        event: 'meta_audiences_get_db_error',
        request_id: requestId,
        step: 'resolve_launch',
        error: err instanceof Error ? err.message : 'unknown',
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    if (!launchId) {
      return c.json(
        { code: 'launch_not_found', request_id: requestId },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // Query audiences — ordered by subtype priority then name
    // Priority: CUSTOM (0) → WEBSITE (1) → IG_BUSINESS (2) → LOOKALIKE (3) → other (4)
    let dbRows: Array<{
      id: string;
      metaAudienceId: string;
      name: string;
      subtype: string;
      approxCount: number | null;
      deliveryStatusCode: number | null;
      deliveryStatusDescription: string | null;
      syncedAt: Date;
    }> = [];

    try {
      dbRows = await db
        .select({
          id: metaAudiences.id,
          metaAudienceId: metaAudiences.metaAudienceId,
          name: metaAudiences.name,
          subtype: metaAudiences.subtype,
          approxCount: metaAudiences.approxCount,
          deliveryStatusCode: metaAudiences.deliveryStatusCode,
          deliveryStatusDescription: metaAudiences.deliveryStatusDescription,
          syncedAt: metaAudiences.syncedAt,
        })
        .from(metaAudiences)
        .where(
          and(
            eq(metaAudiences.workspaceId, workspaceId),
            eq(metaAudiences.launchId, launchId),
          ),
        )
        .orderBy(
          sql`CASE subtype
            WHEN 'CUSTOM' THEN 0
            WHEN 'WEBSITE' THEN 1
            WHEN 'IG_BUSINESS' THEN 2
            WHEN 'LOOKALIKE' THEN 3
            ELSE 4
          END`,
          metaAudiences.name,
        );
    } catch (err) {
      safeLog('error', {
        event: 'meta_audiences_get_db_error',
        request_id: requestId,
        step: 'query_audiences',
        error: err instanceof Error ? err.message : 'unknown',
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // Compute last_synced_at as max(synced_at)
    const lastSyncedAt =
      dbRows.length > 0
        ? dbRows.reduce(
            (max, row) =>
              row.syncedAt > max ? row.syncedAt : max,
            dbRows[0]!.syncedAt,
          ).toISOString()
        : null;

    const response: MetaAudiencesResponse = {
      audiences: dbRows.map((row) => ({
        id: row.id,
        meta_audience_id: row.metaAudienceId,
        name: row.name,
        // Coerce to allowed enum values; fallback to the raw value so the
        // Zod parse below can catch unexpected subtypes if schema drifts.
        subtype: row.subtype as 'CUSTOM' | 'WEBSITE' | 'LOOKALIKE' | 'IG_BUSINESS',
        approx_count: row.approxCount,
        delivery_status_code: row.deliveryStatusCode,
        delivery_status_description: row.deliveryStatusDescription,
        synced_at: row.syncedAt.toISOString(),
      })),
      last_synced_at: lastSyncedAt,
    };

    // Validate response with Zod before sending — guards against schema drift
    const parsed = metaAudiencesResponseSchema.safeParse(response);
    if (!parsed.success) {
      safeLog('error', {
        event: 'meta_audiences_response_schema_drift',
        request_id: requestId,
        issues_count: parsed.error.issues.length,
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    return c.json(parsed.data, 200, {
      'X-Request-Id': requestId,
      'Cache-Control': 'private, max-age=30',
    });
  });

  return route;
}
