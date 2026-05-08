/**
 * routes/launch-products.ts — assoc product ↔ launch com launch_role tipado.
 *
 * Endpoints:
 *   GET    /v1/launches/:launch_public_id/products
 *   PUT    /v1/launches/:launch_public_id/products/:product_id
 *   DELETE /v1/launches/:launch_public_id/products/:product_id
 *
 * Substitui o mapeamento legacy em workspaces.config.integrations.guru.product_launch_map.
 *
 * Auth: Supabase JWT igual leads-timeline / products.
 * BR-RBAC-001/002: workspace_id sempre da auth context. GET ≥ viewer; PUT/DELETE ≥ admin.
 * BR-PRIVACY-001: respostas de erro não ecoam payload.
 */

import {
  createDb,
  launches,
  launchProducts,
  products,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { isValidRole, type WorkspaceRole } from '../lib/rbac.js';
import {
  supabaseJwtMiddleware,
  type LookupWorkspaceMemberFn,
} from '../middleware/auth-supabase-jwt.js';
import { safeLog } from '../middleware/sanitize-logs.js';

type AppBindings = {
  HYPERDRIVE?: Hyperdrive;
  ENVIRONMENT?: string;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  SUPABASE_URL?: string;
};

type AppVariables = {
  workspace_id?: string;
  user_id?: string;
  role?: WorkspaceRole;
  request_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

const LAUNCH_ROLES = [
  'main_offer',
  'main_order_bump',
  'bait_offer',
  'bait_order_bump',
] as const;
export type LaunchRole = (typeof LAUNCH_ROLES)[number];

const PutBodySchema = z
  .object({
    launch_role: z.enum(LAUNCH_ROLES),
  })
  .strict();

export function createLaunchProductsRoute(opts?: {
  getConnStr?: (env: AppBindings) => string;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveConnStr(env: AppBindings): string {
    if (opts?.getConnStr) return opts.getConnStr(env);
    return env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '';
  }

  function resolveDb(env: AppBindings): Db | null {
    const connStr = resolveConnStr(env);
    if (!connStr) return null;
    return createDb(connStr);
  }

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

  // Helper: resolve launch_id from public_id, scoped by workspace.
  async function resolveLaunch(
    db: Db,
    workspaceId: string,
    launchPublicId: string,
  ): Promise<{ id: string } | null> {
    const rows = await db
      .select({ id: launches.id })
      .from(launches)
      .where(
        and(
          eq(launches.workspaceId, workspaceId),
          eq(launches.publicId, launchPublicId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // GET / — list products associated with this launch.
  // -------------------------------------------------------------------------
  route.get('/', async (c) => {
    const requestId =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    const launchPublicId = c.req.param('launch_public_id');

    if (!workspaceId) {
      return c.json(
        { code: 'unauthorized', message: 'Missing workspace context', request_id: requestId },
        401,
      );
    }
    if (!launchPublicId) {
      return c.json(
        { code: 'validation_error', message: 'launch_public_id required', request_id: requestId },
        400,
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'configuration_error', message: 'DB not configured', request_id: requestId },
        500,
      );
    }

    const launch = await resolveLaunch(db, workspaceId, launchPublicId);
    if (!launch) {
      return c.json(
        { code: 'not_found', message: 'Launch not found', request_id: requestId },
        404,
      );
    }

    const rows = await db
      .select({
        id: launchProducts.id,
        product_id: products.id,
        name: products.name,
        category: products.category,
        external_provider: products.externalProvider,
        external_product_id: products.externalProductId,
        launch_role: launchProducts.launchRole,
        created_at: launchProducts.createdAt,
        updated_at: launchProducts.updatedAt,
      })
      .from(launchProducts)
      .innerJoin(products, eq(products.id, launchProducts.productId))
      .where(
        and(
          eq(launchProducts.workspaceId, workspaceId),
          eq(launchProducts.launchId, launch.id),
        ),
      );

    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        product_id: r.product_id,
        name: r.name,
        category: r.category,
        external_provider: r.external_provider,
        external_product_id: r.external_product_id,
        launch_role: r.launch_role as LaunchRole,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // PUT /:product_id — upsert assoc with role. Body: { launch_role }
  // -------------------------------------------------------------------------
  route.put('/:product_id', async (c) => {
    const requestId =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    const role = c.get('role') as WorkspaceRole | undefined;
    const launchPublicId = c.req.param('launch_public_id');
    const productId = c.req.param('product_id');

    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401);
    }
    if (role !== 'owner' && role !== 'admin') {
      return c.json({ code: 'forbidden', request_id: requestId }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: 'validation_error', message: 'Invalid JSON', request_id: requestId },
        400,
      );
    }
    const parsed = PutBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: 'validation_error', message: 'Invalid body', request_id: requestId },
        400,
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'configuration_error', request_id: requestId },
        500,
      );
    }

    const launch = await resolveLaunch(db, workspaceId, launchPublicId ?? '');
    if (!launch) {
      return c.json(
        { code: 'not_found', message: 'Launch not found', request_id: requestId },
        404,
      );
    }

    // Verify product belongs to workspace (RLS-tight)
    const [prod] = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.id, productId ?? ''),
          eq(products.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!prod) {
      return c.json(
        { code: 'not_found', message: 'Product not found', request_id: requestId },
        404,
      );
    }

    // Upsert via INSERT ... ON CONFLICT
    try {
      await db
        .insert(launchProducts)
        .values({
          workspaceId,
          launchId: launch.id,
          productId: prod.id,
          launchRole: parsed.data.launch_role,
        })
        .onConflictDoUpdate({
          target: [launchProducts.launchId, launchProducts.productId],
          set: {
            launchRole: parsed.data.launch_role,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      safeLog('error', {
        event: 'launch_products_upsert_failed',
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
      );
    }

    return c.json({ ok: true, launch_role: parsed.data.launch_role });
  });

  // -------------------------------------------------------------------------
  // DELETE /:product_id — remove assoc.
  // -------------------------------------------------------------------------
  route.delete('/:product_id', async (c) => {
    const requestId =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    const role = c.get('role') as WorkspaceRole | undefined;
    const launchPublicId = c.req.param('launch_public_id');
    const productId = c.req.param('product_id');

    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401);
    }
    if (role !== 'owner' && role !== 'admin') {
      return c.json({ code: 'forbidden', request_id: requestId }, 403);
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json({ code: 'configuration_error', request_id: requestId }, 500);
    }

    const launch = await resolveLaunch(db, workspaceId, launchPublicId ?? '');
    if (!launch) {
      return c.json(
        { code: 'not_found', request_id: requestId },
        404,
      );
    }

    await db
      .delete(launchProducts)
      .where(
        and(
          eq(launchProducts.workspaceId, workspaceId),
          eq(launchProducts.launchId, launch.id),
          eq(launchProducts.productId, productId ?? ''),
        ),
      );

    return c.json({ ok: true });
  });

  return route;
}

export default createLaunchProductsRoute();
