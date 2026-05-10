/**
 * routes/leads-purchases.ts — GET /v1/leads/:public_id/purchases
 *
 * Retorna as compras (event_name='Purchase') de um lead agrupadas por
 * transaction_group_id. Eventos do mesmo grupo (produto principal + order bumps)
 * são consolidados num único "pacotinho" com total_amount e lista de items.
 *
 * Auth: supabaseJwtMiddleware — mesmo padrão de leads-summary.ts.
 * BR-IDENTITY-013: :public_id é leads.id (UUID externo).
 * BR-PRIVACY-001: resposta não carrega PII; nenhum email/telefone nos logs.
 */

import {
  createDb,
  events,
  leads,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { isValidRole } from '../lib/rbac.js';
import {
  supabaseJwtMiddleware,
  type LookupWorkspaceMemberFn,
} from '../middleware/auth-supabase-jwt.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env / context types (mesma shape dos outros sub-routers de leads)
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  SUPABASE_URL?: string;
};

type AppVariables = {
  workspace_id?: string;
  request_id?: string;
  role?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

interface PurchaseItem {
  event_id: string;
  item_type: 'product' | 'order_bump' | string | null;
  amount: number;
  product_name: string | null;
  order_id: string | null;
  occurred_at: string;
}

interface PurchaseGroup {
  transaction_group_id: string | null;
  total_amount: number;
  currency: string;
  occurred_at: string;
  item_count: number;
  items: PurchaseItem[];
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export type CreateLeadsPurchasesRouteOpts = {
  getConnStr: (env: AppBindings) => string;
  buildDb?: (env: AppBindings) => Db;
};

export function createLeadsPurchasesRoute(
  opts: CreateLeadsPurchasesRouteOpts,
): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveDb(env: AppBindings): Db {
    if (opts.buildDb) return opts.buildDb(env);
    return createDb(opts.getConnStr(env));
  }

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
  // GET /:public_id/purchases
  // -------------------------------------------------------------------------
  route.get('/:public_id/purchases', async (c) => {
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
        {
          code: 'validation_error',
          message: 'public_id is required',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);

    // Resolve lead interno pelo public_id (= leads.id) com scope de workspace.
    // BR-IDENTITY-013: public_id é leads.id; nunca expor lead_id interno.
    let leadInternalId: string;
    try {
      const leadRows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.id, publicId), eq(leads.workspaceId, workspaceId)))
        .limit(1);

      const leadRow = leadRows[0];
      if (!leadRow) {
        return c.json(
          { code: 'lead_not_found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }
      leadInternalId = leadRow.id;
    } catch (err) {
      safeLog('error', {
        event: 'leads_purchases_lead_lookup_error',
        request_id: requestId,
        error_name: err instanceof Error ? err.name : 'unknown',
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // Buscar todos os eventos Purchase do lead.
    let purchaseEvents: Array<typeof events.$inferSelect>;
    try {
      purchaseEvents = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.workspaceId, workspaceId),
            eq(events.leadId, leadInternalId),
            eq(events.eventName, 'Purchase'),
          ),
        );
    } catch (err) {
      safeLog('error', {
        event: 'leads_purchases_query_error',
        request_id: requestId,
        error_name: err instanceof Error ? err.name : 'unknown',
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // Agrupamento em memória.
    // Grupos com transaction_group_id não-null são consolidados;
    // eventos sem transaction_group_id viram grupos individuais.
    const groupMap = new Map<string, PurchaseGroup>();

    for (const ev of purchaseEvents) {
      const cd = (ev.customData ?? {}) as Record<string, unknown>;

      const transactionGroupId =
        typeof cd.transaction_group_id === 'string'
          ? cd.transaction_group_id
          : null;

      const itemType =
        typeof cd.item_type === 'string' ? cd.item_type : null;

      const amount =
        typeof cd.amount === 'number'
          ? cd.amount
          : typeof cd.amount === 'string'
            ? Number.parseFloat(cd.amount)
            : 0;

      const currency =
        typeof cd.currency === 'string' ? cd.currency : 'BRL';

      const productName =
        typeof cd.product_name === 'string' ? cd.product_name : null;

      const orderId =
        typeof cd.order_id === 'string' ? cd.order_id : null;

      const occurredAt = ev.eventTime.toISOString();

      const item: PurchaseItem = {
        event_id: ev.id,
        item_type: itemType,
        amount: Number.isNaN(amount) ? 0 : amount,
        product_name: productName,
        order_id: orderId,
        occurred_at: occurredAt,
      };

      // Chave do grupo: transaction_group_id se existir, ou o event_id (único).
      const groupKey = transactionGroupId ?? ev.id;

      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.items.push(item);
        existing.total_amount += item.amount;
        existing.item_count += 1;
        // occurred_at do grupo = min(event_time) do grupo
        if (occurredAt < existing.occurred_at) {
          existing.occurred_at = occurredAt;
        }
      } else {
        groupMap.set(groupKey, {
          transaction_group_id: transactionGroupId,
          total_amount: item.amount,
          currency,
          occurred_at: occurredAt,
          item_count: 1,
          items: [item],
        });
      }
    }

    // Ordenar grupos por occurred_at DESC (mais recente primeiro).
    const purchaseGroups = Array.from(groupMap.values()).sort(
      (a, b) => b.occurred_at.localeCompare(a.occurred_at),
    );

    // Dentro de cada grupo: 'product' primeiro, depois os demais.
    for (const group of purchaseGroups) {
      group.items.sort((a, b) => {
        if (a.item_type === 'product' && b.item_type !== 'product') return -1;
        if (a.item_type !== 'product' && b.item_type === 'product') return 1;
        return a.occurred_at.localeCompare(b.occurred_at);
      });
    }

    return c.json(
      { purchase_groups: purchaseGroups },
      200,
      {
        'X-Request-Id': requestId,
        'Cache-Control': 'private, max-age=30',
      },
    );
  });

  return route;
}
