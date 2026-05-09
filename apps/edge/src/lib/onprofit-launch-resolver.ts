/**
 * onprofit-launch-resolver.ts — Resolves launch_id for an inbound OnProfit webhook event.
 *
 * Mirror estrutural de `guru-launch-resolver.ts` (T-FUNIL-020). Mesma cadeia
 * de estratégias, ajustada para OnProfit: external_provider='onprofit'.
 *
 * Strategy chain (em ordem):
 *   0. launch_products  — JOIN products via (workspace, provider='onprofit', external_product_id)
 *                         → primary path desde T-PRODUCTS-008.
 *   1. mapping (legacy) — workspace.config.integrations.onprofit.product_launch_map
 *                         (paridade com Guru — ainda não há UI, mas o suporte
 *                         existe se alguém setar manualmente via PATCH).
 *   2. last_attribution — lookup lead by hints, find most recent lead_attribution row.
 *   3. none             — sem dados; retorna launch_id null.
 *
 * BR-AUDIT-001: safeLog em cada resolução.
 * BR-PRIVACY-001: leadHints (email/phone) nunca são logados.
 * INV-FUNNEL-001..004: nenhuma mutação de funnel state aqui.
 *
 * T-ID: ONPROFIT-LAUNCH-RESOLVER-TODO (resolvido 2026-05-09).
 */

import type { Db } from '@globaltracker/db';
import {
  launchProducts,
  leadAliases,
  leadAttributions,
  launches,
  products,
  workspaces,
} from '@globaltracker/db';
import { and, desc, eq } from 'drizzle-orm';
import { safeLog } from '../middleware/sanitize-logs.js';
import { hashPii } from './pii.js';
import { normalizeEmail, normalizePhone } from './lead-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnProfitLaunchResolutionResult = {
  launch_id: string | null;
  funnel_role: string | null;
  strategy: 'launch_products' | 'mapping' | 'last_attribution' | 'none';
};

export type ResolveOnProfitLaunchParams = {
  workspaceId: string;
  productId: string | null | undefined;
  leadHints: {
    email?: string | null;
    phone?: string | null;
    visitorId?: string | null;
  };
  db: Db;
};

// ---------------------------------------------------------------------------
// Internal helpers — mirror guru-launch-resolver.ts intencionalmente
// ---------------------------------------------------------------------------

type ProductLaunchMapEntry = {
  launch_public_id: string;
  funnel_role: string;
};

type ProductLaunchMap = Record<string, ProductLaunchMapEntry>;

/**
 * Extrai workspace.config.integrations.onprofit.product_launch_map.
 * Vazio se config ausente/malformado. Nunca loga values.
 */
function extractProductLaunchMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config é open JSONB
  config: any,
): ProductLaunchMap {
  if (
    config &&
    typeof config === 'object' &&
    config.integrations &&
    typeof config.integrations === 'object' &&
    config.integrations.onprofit &&
    typeof config.integrations.onprofit === 'object' &&
    config.integrations.onprofit.product_launch_map &&
    typeof config.integrations.onprofit.product_launch_map === 'object'
  ) {
    return config.integrations.onprofit.product_launch_map as ProductLaunchMap;
  }
  return {};
}

async function resolveLaunchByPublicId(
  workspaceId: string,
  launchPublicId: string,
  db: Db,
): Promise<string | null> {
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

  return rows[0]?.id ?? null;
}

/**
 * Resolve lead_id por hints sem criar lead. Retorna null se não bate.
 * BR-PRIVACY-001: hashes antes de query; raw values nunca logados.
 * BR-IDENTITY-002: normaliza antes do hash.
 */
async function resolveLeadIdFromHints(
  workspaceId: string,
  hints: {
    email?: string | null;
    phone?: string | null;
    visitorId?: string | null;
  },
  db: Db,
): Promise<string | null> {
  const hashes: string[] = [];

  if (hints.email) {
    const normalized = normalizeEmail(hints.email);
    const hash = await hashPii(normalized, workspaceId);
    hashes.push(hash);
  }

  if (hints.phone) {
    const normalized = normalizePhone(hints.phone);
    if (normalized) {
      const hash = await hashPii(normalized, workspaceId);
      hashes.push(hash);
    }
  }

  if (hints.visitorId) {
    const normalized = hints.visitorId.trim();
    const hash = await hashPii(normalized, workspaceId);
    hashes.push(hash);
  }

  if (hashes.length === 0) return null;

  // Mesmo padrão de guru-launch-resolver: 1 query por hash, retorna primeiro match.
  for (const hash of hashes) {
    const rows = await db
      .select({ leadId: leadAliases.leadId })
      .from(leadAliases)
      .where(
        and(
          eq(leadAliases.workspaceId, workspaceId),
          eq(leadAliases.identifierHash, hash),
          eq(leadAliases.status, 'active'),
        ),
      )
      .limit(1);

    if (rows[0]) return rows[0].leadId;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve launch_id + funnel_role para um evento OnProfit.
 *
 * BR-PRIVACY-001: leadHints nunca passados a safeLog.
 * INV-FUNNEL-001..004: sem mutação de funnel.
 */
export async function resolveLaunchForOnProfitEvent(
  params: ResolveOnProfitLaunchParams,
): Promise<OnProfitLaunchResolutionResult> {
  const { workspaceId, productId, leadHints, db } = params;

  // ------------------------------------------------------------------
  // Strategy 0: launch_products (primary)
  // ------------------------------------------------------------------
  if (productId) {
    const lpRows = await db
      .select({
        launchId: launchProducts.launchId,
        launchRole: launchProducts.launchRole,
      })
      .from(launchProducts)
      .innerJoin(products, eq(products.id, launchProducts.productId))
      .where(
        and(
          eq(launchProducts.workspaceId, workspaceId),
          eq(products.workspaceId, workspaceId),
          eq(products.externalProvider, 'onprofit'),
          eq(products.externalProductId, productId),
        ),
      )
      .limit(1);

    if (lpRows[0]) {
      const result: OnProfitLaunchResolutionResult = {
        launch_id: lpRows[0].launchId,
        funnel_role: lpRows[0].launchRole,
        strategy: 'launch_products',
      };
      safeLog('info', {
        event: 'onprofit_launch_resolved',
        workspace_id: workspaceId,
        product_id: productId,
        strategy: result.strategy,
        launch_id: result.launch_id,
        funnel_role: result.funnel_role,
      });
      return result;
    }
  }

  // ------------------------------------------------------------------
  // Strategy 1: product_launch_map (legacy fallback — paridade com Guru)
  // ------------------------------------------------------------------
  if (productId) {
    const workspaceRows = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const config = workspaceRows[0]?.config;
    const map = extractProductLaunchMap(config);
    const entry = map[productId];

    if (entry && entry.launch_public_id) {
      const launchId = await resolveLaunchByPublicId(
        workspaceId,
        entry.launch_public_id,
        db,
      );

      if (launchId) {
        const result: OnProfitLaunchResolutionResult = {
          launch_id: launchId,
          funnel_role: entry.funnel_role ?? null,
          strategy: 'mapping',
        };
        safeLog('info', {
          event: 'onprofit_launch_resolved',
          workspace_id: workspaceId,
          product_id: productId,
          strategy: result.strategy,
          launch_id: result.launch_id,
          funnel_role: result.funnel_role,
        });
        return result;
      }
    }
  }

  // ------------------------------------------------------------------
  // Strategy 2: last_attribution
  // ------------------------------------------------------------------
  const leadId = await resolveLeadIdFromHints(workspaceId, leadHints, db);

  if (leadId) {
    const attributionRows = await db
      .select({ launchId: leadAttributions.launchId })
      .from(leadAttributions)
      .where(
        and(
          eq(leadAttributions.workspaceId, workspaceId),
          eq(leadAttributions.leadId, leadId),
        ),
      )
      .orderBy(desc(leadAttributions.createdAt))
      .limit(1);

    const launchId = attributionRows[0]?.launchId ?? null;

    if (launchId) {
      const result: OnProfitLaunchResolutionResult = {
        launch_id: launchId,
        funnel_role: null,
        strategy: 'last_attribution',
      };
      safeLog('info', {
        event: 'onprofit_launch_resolved',
        workspace_id: workspaceId,
        product_id: productId ?? null,
        strategy: result.strategy,
        launch_id: result.launch_id,
        funnel_role: result.funnel_role,
      });
      return result;
    }
  }

  // ------------------------------------------------------------------
  // Strategy 3: none
  // ------------------------------------------------------------------
  const result: OnProfitLaunchResolutionResult = {
    launch_id: null,
    funnel_role: null,
    strategy: 'none',
  };
  safeLog('info', {
    event: 'onprofit_launch_resolved',
    workspace_id: workspaceId,
    product_id: productId ?? null,
    strategy: result.strategy,
    launch_id: result.launch_id,
    funnel_role: result.funnel_role,
  });
  return result;
}
