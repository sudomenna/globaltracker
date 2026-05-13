/**
 * routes/recovery.ts — GET /v1/launches/:public_id/recovery
 *
 * Returns a cursor-paginated list of recovery events for a given launch.
 * Recovery events are those that signal purchase intent that was not completed:
 *   - InitiateCheckout (abandoned checkout)
 *   - OrderCanceled    (canceled sale)
 *   - RefundProcessed  (refund)
 *   - Chargeback       (chargeback)
 *
 * All events originate from event_source = 'webhook:guru'.
 *
 * T-RECOVERY-004
 *
 * Auth: Supabase JWT — same pattern as leads-timeline and launch-products.
 *   workspace_id is resolved from JWT membership, never from request body.
 *   BR-RBAC-001: workspace_id from auth context.
 *
 * Pagination:
 *   cursor = ISO timestamp; only events with event_time < cursor are returned.
 *   next_cursor = ISO timestamp of the last item returned, or null when no more pages.
 *
 * BR-PRIVACY-001: zero PII in logs and error responses.
 *   display_email and display_phone are decrypted on-demand; never logged.
 * BR-RBAC-001: workspace_id resolved from auth context, never from body/path.
 */

import {
  createDb,
  events,
  launches,
  leads,
  workspaceMembers,
} from '@globaltracker/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { decryptPii } from '../lib/pii.js';
import { isValidRole } from '../lib/rbac.js';
import {
  supabaseJwtMiddleware,
  type LookupWorkspaceMemberFn,
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
// Constants
// ---------------------------------------------------------------------------

// BR-EVENT-001: recovery event names sourced from webhook:guru
const RECOVERY_EVENT_NAMES = [
  'InitiateCheckout',
  'OrderCanceled',
  'RefundProcessed',
  'Chargeback',
] as const;

type RecoveryEventName = (typeof RECOVERY_EVENT_NAMES)[number];

// ---------------------------------------------------------------------------
// Query parameter schema
// ---------------------------------------------------------------------------

const RecoveryQuerySchema = z
  .object({
    limit: z.coerce.number().min(1).max(100).default(50),
    cursor: z.string().optional(), // ISO timestamp — only events before this are returned
    event_type: z.enum(RECOVERY_EVENT_NAMES).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Response item type
// ---------------------------------------------------------------------------

export type RecoveryItem = {
  event_id: string;
  event_name: string;
  event_time: string;
  lead_id: string;
  lead_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  amount: number | null;
  currency: string | null;
  product_name: string | null;
};

export type RecoveryResponse = {
  items: RecoveryItem[];
  next_cursor: string | null;
  total: number;
};

// ---------------------------------------------------------------------------
// Custom data parser — defensive against double-encoded jsonb
// ---------------------------------------------------------------------------

function parseCustomData(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // unparseable → empty
    }
    return {};
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createRecoveryRoute(opts?: {
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

  // ---------------------------------------------------------------------------
  // Auth middleware — verifies Supabase JWT and resolves workspace_member.
  // Same pattern as leads-timeline and launch-products.
  // BR-RBAC-001: workspace_id from membership lookup, never from request body.
  // ---------------------------------------------------------------------------
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
  // GET /:public_id/recovery
  // -------------------------------------------------------------------------
  route.get('/:public_id/recovery', async (c) => {
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
    const queryParseResult = RecoveryQuerySchema.safeParse({
      limit: rawQuery.limit,
      cursor: rawQuery.cursor,
      event_type: rawQuery.event_type,
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

    const { limit, cursor, event_type } = queryParseResult.data;

    // Validate cursor is a parseable ISO timestamp when provided.
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
      safeLog('error', { event: 'recovery_no_db_connection', request_id: requestId });
      return c.json({ code: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    const db = createDb(connStr);

    // -----------------------------------------------------------------------
    // 5. Resolve launch internal ID from public_id, scoped to workspace.
    //    BR-RBAC-001: WHERE workspace_id ensures cross-workspace isolation.
    // -----------------------------------------------------------------------
    let launchId: string;
    try {
      const launchRows = await db
        .select({ id: launches.id })
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
        return c.json({ code: 'launch_not_found', request_id: requestId }, 404, {
          'X-Request-Id': requestId,
        });
      }
      launchId = launchRow.id;
    } catch (err) {
      // BR-PRIVACY-001: no PII in log
      safeLog('error', {
        event: 'recovery_launch_lookup_error',
        request_id: requestId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json({ code: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // 6. Build event name filter.
    //    When event_type is provided, filter to a single event name.
    //    Otherwise include all RECOVERY_EVENT_NAMES.
    // -----------------------------------------------------------------------
    const eventNamesToQuery: RecoveryEventName[] = event_type
      ? [event_type]
      : [...RECOVERY_EVENT_NAMES];

    // -----------------------------------------------------------------------
    // 7. Query events joined with leads.
    //    Fetch limit + 1 rows to determine if a next page exists.
    //    BR-RBAC-001: workspace_id anchor on both events and launch lookup.
    // -----------------------------------------------------------------------
    let rawRows: Array<{
      eventId: string;
      eventName: string;
      eventTime: Date;
      leadId: string | null;
      leadName: string | null;
      emailEnc: string | null;
      phoneEnc: string | null;
      piiKeyVersion: number;
      customData: unknown;
    }>;

    try {
      const conditions = [
        eq(events.workspaceId, workspaceId),
        eq(events.launchId, launchId),
        inArray(events.eventName, eventNamesToQuery),
        eq(events.eventSource, 'webhook:guru'),
      ];

      if (cursorDate) {
        // Cursor pagination: only events strictly before cursor.
        conditions.push(lt(events.eventTime, cursorDate));
      }

      rawRows = await db
        .select({
          eventId: events.id,
          eventName: events.eventName,
          eventTime: events.eventTime,
          leadId: events.leadId,
          // ADR-034: prefer plaintext leads.name
          leadName: leads.name,
          emailEnc: leads.emailEnc,
          phoneEnc: leads.phoneEnc,
          // Use coalesce to fall back to 1 if lead has no pii_key_version context
          piiKeyVersion: sql<number>`COALESCE(${leads.piiKeyVersion}, 1)`,
          customData: events.customData,
        })
        .from(events)
        .leftJoin(leads, eq(events.leadId, leads.id))
        .where(and(...conditions))
        .orderBy(
          // Descending — most recent first
          sql`${events.eventTime} DESC`,
        )
        .limit(limit + 1);
    } catch (err) {
      // BR-PRIVACY-001: no PII in log
      safeLog('error', {
        event: 'recovery_query_error',
        request_id: requestId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json({ code: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // 8. Determine pagination state.
    // -----------------------------------------------------------------------
    const hasMore = rawRows.length > limit;
    const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
    const total = pageRows.length; // total for this page (not a full count)
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow ? lastRow.eventTime.toISOString() : null;

    // -----------------------------------------------------------------------
    // 9. Decrypt PII fields and build response items.
    //    BR-PRIVACY-001: decrypted values are never logged.
    //    Decryption is best-effort: null on failure (key missing or corrupt).
    // -----------------------------------------------------------------------
    const masterKey = resolveMasterKey(c.env);
    const masterKeyRegistry: Record<number, string> = masterKey
      ? { 1: masterKey }
      : {};

    async function decryptOrNull(
      ciphertext: string | null,
      wsId: string,
      keyVersion: number,
    ): Promise<string | null> {
      if (!ciphertext) return null;
      if (!masterKey) return null;
      const r = await decryptPii(ciphertext, wsId, masterKeyRegistry, keyVersion);
      return r.ok ? r.value : null;
    }

    const items: RecoveryItem[] = await Promise.all(
      pageRows.map(async (row) => {
        // BR-PRIVACY-001: decrypt email/phone; never log plaintext
        const [displayEmail, displayPhone] = await Promise.all([
          decryptOrNull(row.emailEnc, workspaceId, row.piiKeyVersion),
          decryptOrNull(row.phoneEnc, workspaceId, row.piiKeyVersion),
        ]);

        // Defensive parse of custom_data jsonb (may be double-encoded)
        const cd = parseCustomData(row.customData);

        const amount =
          typeof cd.amount === 'number'
            ? cd.amount
            : typeof cd.amount === 'string'
              ? parseFloat(cd.amount) || null
              : null;

        return {
          event_id: row.eventId,
          event_name: row.eventName,
          event_time: row.eventTime.toISOString(),
          lead_id: row.leadId ?? '',
          lead_name: row.leadName ?? null,
          display_email: displayEmail,
          display_phone: displayPhone,
          amount: amount,
          currency: typeof cd.currency === 'string' ? cd.currency : null,
          product_name: typeof cd.product_name === 'string' ? cd.product_name : null,
        };
      }),
    );

    const response: RecoveryResponse = {
      items,
      next_cursor: nextCursor,
      total,
    };

    return c.json(response, 200, { 'X-Request-Id': requestId });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance for simple wiring.
// ---------------------------------------------------------------------------
export const recoveryRoute = createRecoveryRoute();
