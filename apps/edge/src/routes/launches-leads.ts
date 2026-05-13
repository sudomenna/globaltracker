/**
 * routes/launches-leads.ts — GET /v1/launches/:public_id/leads
 *
 * Returns a cursor-paginated list of leads that have touched the launch's
 * funnel (events.launch_id matches OR lead_stages.launch_id matches), with
 * dynamically computed boolean flags driven by `funnel_blueprint.leads_view`.
 *
 * T-LEADS-VIEW-002
 *
 * Auth: Supabase JWT — same pattern as recovery.ts and leads-timeline.ts.
 *   workspace_id is resolved from JWT membership, never from request body.
 *   BR-RBAC-001: workspace_id from auth context.
 *
 * RBAC / masking (BR-IDENTITY-006 / ADR-034):
 *   canSeePiiPlainByDefault(role) → email/phone in clear (owner/admin/marketer/privacy).
 *   else (operator/viewer)         → email/phone masked.
 *
 * Pagination:
 *   cursor = ISO timestamp of leads.created_at; only leads with created_at < cursor are returned.
 *   next_cursor = ISO timestamp of the last item, or null when no more pages.
 *
 * BR-PRIVACY-001: zero PII in logs and error responses.
 *   display_email / display_phone are decrypted on-demand; never logged.
 *
 * SQL strategy: dynamic EXISTS subqueries are built per `leads_view.columns`.
 *   - All values that flow into SQL are passed via Drizzle's parameterized
 *     `sql` template tag — never interpolated as strings — so blueprint payloads
 *     coming from DB cannot inject SQL.
 *   - Column keys (used only as alias names like `col_<key>`) are sanitized
 *     to [a-z0-9_] before use as SQL identifiers.
 *   - The CTE that scopes leads to `launch_leads` ensures we only consider
 *     leads with at least one event OR stage in the launch.
 *
 * MOUNT (apps/edge/src/index.ts):
 *   import { createLaunchLeadsRoute } from './routes/launches-leads.js';
 *   // CRITICAL: must be mounted BEFORE launchesRoute so launchesRoute's
 *   // catch-all auth middleware ('*') does NOT intercept /:public_id/leads.
 *   app.route('/v1/launches', createLaunchLeadsRoute({...}));
 *   app.route('/v1/launches', launchesRoute);
 */

import { createDb, launches, workspaceMembers } from '@globaltracker/db';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { maskEmail, maskPhone } from '../lib/pii-mask.js';
import { decryptPii, hashPii } from '../lib/pii.js';
import {
  type WorkspaceRole,
  canSeePiiPlainByDefault,
  isValidRole,
} from '../lib/rbac.js';
import {
  type LookupWorkspaceMemberFn,
  supabaseJwtMiddleware,
} from '../middleware/auth-supabase-jwt.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env / context types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE?: Hyperdrive;
  ENVIRONMENT?: string;
  DATABASE_URL?: string;
  PII_MASTER_KEY_V1?: string;
  DEV_WORKSPACE_ID?: string;
  SUPABASE_URL?: string;
};

type AppVariables = {
  workspace_id?: string;
  user_id?: string;
  role?: string;
  request_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// LeadsView schema — local definition (edge does not depend on
// @globaltracker/shared; same convention as funnel-scaffolder.ts and
// raw-events-processor.ts). Keep in sync with packages/shared/src/schemas/
// funnel-blueprint.ts (LeadsViewSchema). T-LEADS-VIEW-002.
// ---------------------------------------------------------------------------

const LeadsViewColumnSourceSchema = z.object({
  type: z.enum(['stage', 'event', 'tag']),
  name: z.string().min(1),
});

const LeadsViewColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['stage', 'event', 'tag', 'any']),
  source: z.string().min(1).optional(),
  sources: z.array(LeadsViewColumnSourceSchema).optional(),
});

const LeadsViewSchema = z.object({
  stage_progression: z.array(z.string().min(1)),
  columns: z.array(LeadsViewColumnSchema),
});

type LeadsView = z.infer<typeof LeadsViewSchema>;
type LeadsViewColumn = z.infer<typeof LeadsViewColumnSchema>;

// ---------------------------------------------------------------------------
// Query parameter schema
// ---------------------------------------------------------------------------

const LeadsQuerySchema = z
  .object({
    limit: z.coerce.number().min(1).max(100).default(50),
    cursor: z.string().optional(), // ISO timestamp on leads.created_at
    q: z.string().optional(),
    column_filter: z.string().optional(),
    stage_filter: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Local search detection — duplicated from lib/leads-queries.ts (constants
// not exported there). Same regexes; canonical normalization happens via
// hashPii against `email_hash` / `phone_hash`.
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d][\d\s\-()]+$/;

function normalizeEmailLocal(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhoneLocal(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 8) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export type LaunchLeadItem = {
  lead_id: string;
  lead_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  pii_masked: boolean;
  current_stage: string | null;
  current_stage_index: number | null;
  columns: Record<string, boolean>;
  last_event_at: string | null;
  created_at: string;
};

export type LaunchLeadsResponse = {
  items: LaunchLeadItem[];
  next_cursor: string | null;
  total: number;
  leads_view: LeadsView;
  role: WorkspaceRole | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Defensive parse of jsonb that may arrive as object or as string
 * (depending on driver / column-write history). Mirrors the pattern used
 * across raw-events-processor and recovery.ts.
 */
function parseFunnelBlueprint(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}

/**
 * Sanitize a column key so it's safe to use as a SQL identifier alias.
 * Keys come from `funnel_blueprint.leads_view.columns[].key` — DB origin,
 * potentially editable via admin endpoints. Defensive in depth.
 */
function sanitizeAlias(key: string): string {
  return key
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase()
    .slice(0, 48);
}

/**
 * Build the SQL fragment that resolves a single column to a boolean,
 * using parameterized values for table-level filters.
 *
 * type='tag'   → EXISTS in lead_tags WHERE tag_name = $source
 * type='stage' → EXISTS in lead_stages WHERE launch_id = $launch AND stage = $source
 * type='event' → EXISTS in events WHERE launch_id = $launch AND event_name = $source
 * type='any'   → OR of sub-existences (one per `sources[]` entry).
 */
function buildColumnExpr(
  column: LeadsViewColumn,
  launchId: string,
): ReturnType<typeof sql> {
  const sources =
    column.type === 'any'
      ? (column.sources ?? [])
      : column.source != null
        ? [{ type: column.type, name: column.source }]
        : [];

  if (sources.length === 0) {
    return sql`FALSE`;
  }

  const subExprs = sources.map((src) => {
    switch (src.type) {
      case 'tag':
        return sql`EXISTS (
          SELECT 1 FROM lead_tags t
           WHERE t.lead_id = l.id
             AND t.tag_name = ${src.name}
        )`;
      case 'stage':
        return sql`EXISTS (
          SELECT 1 FROM lead_stages s
           WHERE s.lead_id = l.id
             AND s.launch_id = ${launchId}
             AND s.stage = ${src.name}
        )`;
      case 'event':
        return sql`EXISTS (
          SELECT 1 FROM events e
           WHERE e.lead_id = l.id
             AND e.launch_id = ${launchId}
             AND e.event_name = ${src.name}
        )`;
      default:
        // Defensive — schema enforces enum, this is unreachable.
        return sql`FALSE`;
    }
  });

  const first = subExprs[0];
  if (subExprs.length === 1 && first) return first;

  // Join with OR — sql.join is the canonical way to combine SQL fragments.
  return sql`(${sql.join(subExprs, sql` OR `)})`;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createLaunchLeadsRoute(opts?: {
  getConnStr?: (env: AppBindings) => string;
  getMasterKey?: (env: AppBindings) => string;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveConnStr(env: AppBindings): string {
    if (opts?.getConnStr) return opts.getConnStr(env);
    return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? '';
  }

  function resolveMasterKey(env: AppBindings): string {
    if (opts?.getMasterKey) return opts.getMasterKey(env);
    return env.PII_MASTER_KEY_V1 ?? '';
  }

  // -------------------------------------------------------------------------
  // Auth middleware — same pattern as recovery.ts and leads-timeline.ts.
  // BR-RBAC-001: workspace_id from membership lookup, never from request.
  // -------------------------------------------------------------------------
  const buildLookupMember = (env: AppBindings): LookupWorkspaceMemberFn => {
    return async (userId: string) => {
      const connStr = resolveConnStr(env);
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
  // GET /:public_id/leads
  // -------------------------------------------------------------------------
  route.get('/:public_id/leads', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Resolve workspace_id from auth context.
    //    BR-RBAC-001: workspace_id from membership, never from request.
    // -----------------------------------------------------------------------
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    const role = (c.get('role') as WorkspaceRole | undefined) ?? null;
    const seePlain = canSeePiiPlainByDefault(role);

    // -----------------------------------------------------------------------
    // 2. Validate path param.
    // -----------------------------------------------------------------------
    const launchPublicId = c.req.param('public_id');
    if (!launchPublicId || launchPublicId.trim() === '') {
      return c.json(
        {
          code: 'validation_error',
          message: 'public_id is required',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 3. Validate query params.
    // -----------------------------------------------------------------------
    const rawQuery = c.req.query();
    const queryParseResult = LeadsQuerySchema.safeParse({
      limit: rawQuery.limit,
      cursor: rawQuery.cursor,
      q: rawQuery.q,
      column_filter: rawQuery.column_filter,
      stage_filter: rawQuery.stage_filter,
    });

    if (!queryParseResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid query parameters',
          details: queryParseResult.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const { limit, cursor, q, column_filter, stage_filter } =
      queryParseResult.data;

    let cursorDate: Date | null = null;
    if (cursor) {
      cursorDate = new Date(cursor);
      if (Number.isNaN(cursorDate.getTime())) {
        return c.json(
          {
            code: 'validation_error',
            message: 'cursor must be a valid ISO 8601 timestamp',
            request_id: requestId,
          },
          400,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 4. Connect to DB.
    // -----------------------------------------------------------------------
    const connStr = resolveConnStr(c.env);
    if (!connStr) {
      safeLog('error', {
        event: 'launch_leads_no_db_connection',
        request_id: requestId,
      });
      return c.json({ code: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    const db = createDb(connStr);

    // -----------------------------------------------------------------------
    // 5. Resolve launch + funnel_blueprint, scoped to workspace.
    //    BR-RBAC-001: WHERE workspace_id ensures cross-workspace isolation.
    // -----------------------------------------------------------------------
    let launchId: string;
    let blueprintRaw: unknown;
    try {
      const launchRows = await db
        .select({
          id: launches.id,
          funnelBlueprint: launches.funnelBlueprint,
        })
        .from(launches)
        .where(
          and(
            eq(launches.workspaceId, workspaceId),
            eq(launches.publicId, launchPublicId),
          ),
        )
        .limit(1);

      const launchRow = launchRows[0];
      if (!launchRow) {
        return c.json(
          { code: 'launch_not_found', request_id: requestId },
          404,
          {
            'X-Request-Id': requestId,
          },
        );
      }
      launchId = launchRow.id;
      blueprintRaw = launchRow.funnelBlueprint;
    } catch (err) {
      safeLog('error', {
        event: 'launch_leads_launch_lookup_error',
        request_id: requestId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json({ code: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // 6. Extract and validate `leads_view` from blueprint.
    // -----------------------------------------------------------------------
    const blueprint = parseFunnelBlueprint(blueprintRaw);
    if (
      !blueprint ||
      !('leads_view' in blueprint) ||
      blueprint.leads_view == null
    ) {
      return c.json(
        {
          code: 'leads_view_not_configured',
          message: 'Launch funnel_blueprint.leads_view is not set',
          request_id: requestId,
        },
        422,
        { 'X-Request-Id': requestId },
      );
    }

    const leadsViewParse = LeadsViewSchema.safeParse(blueprint.leads_view);
    if (!leadsViewParse.success) {
      safeLog('error', {
        event: 'launch_leads_view_invalid',
        request_id: requestId,
        // Issues from Zod do not contain PII (they reference field names + types).
        issues: leadsViewParse.error.flatten().fieldErrors,
      });
      return c.json(
        {
          code: 'leads_view_invalid',
          message: 'Launch funnel_blueprint.leads_view failed validation',
          request_id: requestId,
        },
        422,
        { 'X-Request-Id': requestId },
      );
    }

    const leadsView = leadsViewParse.data;
    const progression = leadsView.stage_progression;
    const columns = leadsView.columns;

    // pg-cloudflare-workers driver does not serialize JS arrays into PG text[]
    // properly when bound via parameter (same family of bugs as the jsonb-cast
    // helper). Convert to a PG array literal string `{"a","b","c"}` and cast
    // explicitly. Each element is escaped (double-quote + backslash).
    const progressionLiteral = `{${progression
      .map((p) => `"${p.replace(/[\\"]/g, '\\$&')}"`)
      .join(',')}}`;

    // -----------------------------------------------------------------------
    // 7. Validate column_filter / stage_filter against config.
    //    Defensive: only allow values present in `leads_view`. Prevents
    //    arbitrary attribute probing via the filter param.
    // -----------------------------------------------------------------------
    let columnFilterColumn: LeadsViewColumn | null = null;
    if (column_filter) {
      columnFilterColumn =
        columns.find((c2) => c2.key === column_filter) ?? null;
      if (!columnFilterColumn) {
        return c.json(
          {
            code: 'validation_error',
            message: `Unknown column_filter '${column_filter}'`,
            request_id: requestId,
          },
          400,
          { 'X-Request-Id': requestId },
        );
      }
    }

    if (stage_filter && !progression.includes(stage_filter)) {
      return c.json(
        {
          code: 'validation_error',
          message: `Unknown stage_filter '${stage_filter}'`,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 8. Optional q-search → translate into a WHERE condition.
    //    UUID  → l.id = $q
    //    Email → hashPii(workspace, normalized) → l.email_hash = $hash
    //    Phone → hashPii(workspace, normalized) → l.phone_hash = $hash
    //    Else  → ILIKE %q% on l.name
    //
    //    BR-PRIVACY-001: hashes are workspace-scoped (workspace pepper).
    //    BR-IDENTITY-006: search by email/phone never decrypts; it hashes.
    // -----------------------------------------------------------------------
    const trimmedQ = q?.trim();
    let qExpr: ReturnType<typeof sql> | null = null;
    if (trimmedQ) {
      if (UUID_RE.test(trimmedQ)) {
        qExpr = sql`l.id = ${trimmedQ}::uuid`;
      } else if (EMAIL_RE.test(trimmedQ)) {
        const hash = await hashPii(normalizeEmailLocal(trimmedQ), workspaceId);
        qExpr = sql`l.email_hash = ${hash}`;
      } else if (PHONE_RE.test(trimmedQ)) {
        const normalized = normalizePhoneLocal(trimmedQ);
        if (!normalized) {
          // Empty result — short-circuit
          const empty: LaunchLeadsResponse = {
            items: [],
            next_cursor: null,
            total: 0,
            leads_view: leadsView,
            role,
          };
          return c.json(empty, 200, { 'X-Request-Id': requestId });
        }
        const hash = await hashPii(normalized, workspaceId);
        qExpr = sql`l.phone_hash = ${hash}`;
      } else {
        // Name substring — same caveat as lib/leads-queries.ts (idx defeated
        // by leading %). Acceptable at current dataset size.
        qExpr = sql`l.name ILIKE ${`%${trimmedQ}%`}`;
      }
    }

    // -----------------------------------------------------------------------
    // 9. Build dynamic SELECT with one EXISTS expression per column.
    // -----------------------------------------------------------------------
    const columnSelectParts = columns.map((col) => {
      const alias = sanitizeAlias(col.key);
      const expr = buildColumnExpr(col, launchId);
      return sql`${expr} AS ${sql.raw(`"col_${alias}"`)}`;
    });

    // current_stage: pick the stage with the highest array_position in
    // stage_progression. Stages not in the progression sort NULLS LAST,
    // so they don't override known stages.
    const currentStageExpr = sql`(
      SELECT s.stage
        FROM lead_stages s
       WHERE s.lead_id = l.id
         AND s.launch_id = ${launchId}
       ORDER BY array_position(${progressionLiteral}::text[], s.stage) DESC NULLS LAST
       LIMIT 1
    ) AS "current_stage"`;

    // last_event_at: greatest of (max event_time in launch, max stage ts in launch).
    const lastEventAtExpr = sql`GREATEST(
      (SELECT MAX(e.event_time) FROM events e
        WHERE e.lead_id = l.id AND e.launch_id = ${launchId}),
      (SELECT MAX(s.ts) FROM lead_stages s
        WHERE s.lead_id = l.id AND s.launch_id = ${launchId})
    ) AS "last_event_at"`;

    // launch_leads CTE — only leads with at least one event OR stage.
    const launchLeadsCte = sql`
      WITH launch_leads AS (
        SELECT DISTINCT lead_id FROM (
          SELECT lead_id FROM events
            WHERE workspace_id = ${workspaceId}
              AND launch_id    = ${launchId}
              AND lead_id IS NOT NULL
          UNION
          SELECT lead_id FROM lead_stages
            WHERE workspace_id = ${workspaceId}
              AND launch_id    = ${launchId}
        ) sub
      )
    `;

    // WHERE conditions — workspace + launch_leads + optional cursor + q + filters.
    const whereParts: ReturnType<typeof sql>[] = [
      sql`l.workspace_id = ${workspaceId}`,
    ];
    if (cursorDate) {
      whereParts.push(
        sql`l.created_at < ${cursorDate.toISOString()}::timestamptz`,
      );
    }
    if (qExpr) whereParts.push(qExpr);
    if (columnFilterColumn) {
      whereParts.push(buildColumnExpr(columnFilterColumn, launchId));
    }
    if (stage_filter) {
      // Filter rows whose computed current_stage equals stage_filter.
      // We anchor by EXISTS-on-stage AND require the lead has not progressed past
      // stage_filter — but the simpler product-meaning is "currently in this stage".
      // Implementation: filter via subquery comparison.
      whereParts.push(sql`(
        SELECT s.stage FROM lead_stages s
         WHERE s.lead_id = l.id
           AND s.launch_id = ${launchId}
         ORDER BY array_position(${progressionLiteral}::text[], s.stage) DESC NULLS LAST
         LIMIT 1
      ) = ${stage_filter}`);
    }

    const whereClause = sql.join(whereParts, sql` AND `);

    // Final query — bind columns into one SELECT.
    const finalQuery = sql`
      ${launchLeadsCte}
      SELECT
        l.id            AS "lead_id",
        l.name          AS "lead_name",
        l.email_enc     AS "email_enc",
        l.phone_enc     AS "phone_enc",
        COALESCE(l.pii_key_version, 1) AS "pii_key_version",
        l.created_at    AS "created_at",
        ${sql.join(columnSelectParts, sql`, `)},
        ${currentStageExpr},
        ${lastEventAtExpr}
      FROM leads l
      JOIN launch_leads ll ON ll.lead_id = l.id
      WHERE ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT ${limit + 1}
    `;

    // -----------------------------------------------------------------------
    // 10. Execute.
    // -----------------------------------------------------------------------
    type RawRow = {
      lead_id: string;
      lead_name: string | null;
      email_enc: string | null;
      phone_enc: string | null;
      pii_key_version: number;
      created_at: Date | string;
      current_stage: string | null;
      last_event_at: Date | string | null;
      // Plus dynamic col_<alias> boolean columns.
      [k: string]: unknown;
    };

    let rawRows: RawRow[];
    try {
      const result = await db.execute(finalQuery);
      // postgres-js returns an array-like result; Drizzle wraps it.
      rawRows = result as unknown as RawRow[];
    } catch (err) {
      safeLog('error', {
        event: 'launch_leads_query_error',
        request_id: requestId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json({ code: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // 11. Pagination + decrypt + masking.
    // -----------------------------------------------------------------------
    const hasMore = rawRows.length > limit;
    const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
    const total = pageRows.length;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? lastRow.created_at instanceof Date
          ? lastRow.created_at.toISOString()
          : new Date(lastRow.created_at).toISOString()
        : null;

    const masterKey = resolveMasterKey(c.env);
    const masterKeyRegistry: Record<number, string> = masterKey
      ? { 1: masterKey }
      : {};

    // Capture into a non-undefined local — guard above already returned 401
    // when workspaceId was missing.
    const wsId: string = workspaceId;

    async function decryptOrNull(
      ciphertext: string | null,
      keyVersion: number,
    ): Promise<string | null> {
      if (!ciphertext) return null;
      if (!masterKey) return null;
      const r = await decryptPii(
        ciphertext,
        wsId,
        masterKeyRegistry,
        keyVersion,
      );
      return r.ok ? r.value : null;
    }

    const items: LaunchLeadItem[] = await Promise.all(
      pageRows.map(async (row) => {
        // BR-PRIVACY-001: decrypt on-demand; never log plaintext.
        const [decryptedEmail, decryptedPhone] = await Promise.all([
          decryptOrNull(row.email_enc, row.pii_key_version),
          decryptOrNull(row.phone_enc, row.pii_key_version),
        ]);

        // ADR-034 / BR-IDENTITY-006: mask for operator/viewer.
        const displayEmail = seePlain
          ? decryptedEmail
          : maskEmail(decryptedEmail);
        const displayPhone = seePlain
          ? decryptedPhone
          : maskPhone(decryptedPhone);

        // Map dynamic col_<alias> back to the user-facing column key.
        const colsOut: Record<string, boolean> = {};
        for (const col of columns) {
          const alias = sanitizeAlias(col.key);
          const v = row[`col_${alias}`];
          colsOut[col.key] = v === true || v === 't' || v === 1;
        }

        const currentStage = row.current_stage ?? null;
        const currentStageIndex =
          currentStage != null ? progression.indexOf(currentStage) : -1;

        const createdAtIso =
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : new Date(row.created_at).toISOString();

        const lastEventAtIso = row.last_event_at
          ? row.last_event_at instanceof Date
            ? row.last_event_at.toISOString()
            : new Date(row.last_event_at).toISOString()
          : null;

        return {
          lead_id: row.lead_id,
          lead_name: row.lead_name ?? null,
          display_email: displayEmail,
          display_phone: displayPhone,
          pii_masked: !seePlain,
          current_stage: currentStage,
          current_stage_index:
            currentStageIndex >= 0 ? currentStageIndex : null,
          columns: colsOut,
          last_event_at: lastEventAtIso,
          created_at: createdAtIso,
        };
      }),
    );

    const response: LaunchLeadsResponse = {
      items,
      next_cursor: nextCursor,
      total,
      leads_view: leadsView,
      role,
    };

    return c.json(response, 200, { 'X-Request-Id': requestId });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance for simple wiring.
// ---------------------------------------------------------------------------
export const launchLeadsRoute = createLaunchLeadsRoute();
