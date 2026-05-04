/**
 * guru-launch-resolver.ts — Resolves the correct launch_id for an inbound Guru webhook event.
 *
 * T-ID: T-FUNIL-020 (Sprint 11, Onda 1)
 *
 * Strategy chain (in order):
 *   1. mapping       — product_id is present in workspace.config.integrations.guru.product_launch_map
 *   2. last_attribution — lookup lead by hints, find most recent lead_attribution row
 *   3. none          — no data available; returns null launch_id
 *
 * BR-AUDIT-001: safeLog records every resolution for observability without PII.
 * BR-WEBHOOK-001..004 (implicit): leadHints never emitted in logs.
 * BR-PRIVACY-001: no PII in log output — only non-PII fields passed to safeLog.
 *
 * INV-FUNNEL-001..004 honored: no mutation of funnel state occurs here.
 */

import type { Db } from '@globaltracker/db';
import {
  leadAliases,
  leadAttributions,
  launches,
  workspaces,
} from '@globaltracker/db';
import { and, desc, eq } from 'drizzle-orm';
import { safeLog } from '../middleware/sanitize-logs.js';
import { hashPii } from './pii.js';
import { normalizeEmail, normalizePhone } from './lead-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuruLaunchResolutionResult = {
  launch_id: string | null;
  funnel_role: string | null;
  strategy: 'mapping' | 'last_attribution' | 'none';
};

export type ResolveLaunchParams = {
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
// Internal: workspace config shape (subset — guru product_launch_map only)
// ---------------------------------------------------------------------------

type ProductLaunchMapEntry = {
  launch_public_id: string;
  funnel_role: string;
};

type ProductLaunchMap = Record<string, ProductLaunchMapEntry>;

/**
 * Safely extracts the Guru product_launch_map from workspace config JSONB.
 * Returns an empty object if config is absent or malformed.
 *
 * BR-PRIVACY-001: this function never logs config values.
 */
function extractProductLaunchMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config is open JSONB
  config: any,
): ProductLaunchMap {
  if (
    config &&
    typeof config === 'object' &&
    config.integrations &&
    typeof config.integrations === 'object' &&
    config.integrations.guru &&
    typeof config.integrations.guru === 'object' &&
    config.integrations.guru.product_launch_map &&
    typeof config.integrations.guru.product_launch_map === 'object'
  ) {
    return config.integrations.guru.product_launch_map as ProductLaunchMap;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Internal: resolve launch UUID from public_id within workspace
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal: resolve lead_id from hints (email, phone, visitorId)
// ---------------------------------------------------------------------------

/**
 * Resolves a lead_id from available identity hints without creating a new lead.
 * Returns null if no match is found.
 *
 * BR-PRIVACY-001: hints are hashed before any DB lookup; raw values never logged.
 * BR-IDENTITY-002: normalize before hash.
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
    // BR-IDENTITY-002: normalize before hash
    const hash = await hashPii(normalized, workspaceId);
    hashes.push(hash);
  }

  if (hints.phone) {
    const normalized = normalizePhone(hints.phone);
    if (normalized) {
      // BR-IDENTITY-002: normalize before hash
      const hash = await hashPii(normalized, workspaceId);
      hashes.push(hash);
    }
  }

  if (hints.visitorId) {
    // visitorId treated as external_id_hash — trim only, no further normalization
    const normalized = hints.visitorId.trim();
    const hash = await hashPii(normalized, workspaceId);
    hashes.push(hash);
  }

  if (hashes.length === 0) return null;

  // Look up any active alias matching any of the computed hashes
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

    if (rows[0]) {
      return rows[0].leadId;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves the best-fit launch_id and funnel_role for a Guru webhook event.
 *
 * Strategy 1 — mapping (primary):
 *   Read workspace.config.integrations.guru.product_launch_map.
 *   If productId is in the map, resolve the launch by public_id. Return strategy='mapping'.
 *
 * Strategy 2 — last_attribution (fallback):
 *   Look up the lead by leadHints, then find the most recent lead_attribution row.
 *   Copy its launch_id. Return strategy='last_attribution'.
 *
 * Strategy 3 — none:
 *   No data available. Return launch_id=null, funnel_role=null, strategy='none'.
 *
 * BR-AUDIT-001: safeLog records the resolution for audit without PII.
 * BR-PRIVACY-001: leadHints (email, phone) are never passed to safeLog.
 * INV-FUNNEL-001..004: no funnel mutation occurs in this function.
 */
export async function resolveLaunchForGuruEvent(
  params: ResolveLaunchParams,
): Promise<GuruLaunchResolutionResult> {
  const { workspaceId, productId, leadHints, db } = params;

  // ------------------------------------------------------------------
  // Strategy 1: product_launch_map lookup
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
        const result: GuruLaunchResolutionResult = {
          launch_id: launchId,
          funnel_role: entry.funnel_role ?? null,
          strategy: 'mapping',
        };

        // BR-AUDIT-001: structured log for audit trail; no PII emitted
        safeLog('info', {
          event: 'guru_launch_resolved',
          workspace_id: workspaceId,
          product_id: productId,
          strategy: result.strategy,
          launch_id: result.launch_id,
          funnel_role: result.funnel_role,
        });

        return result;
      }
      // map entry exists but launch_id not found — fall through to strategy 2
    }
  }

  // ------------------------------------------------------------------
  // Strategy 2: last_attribution fallback
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
      const result: GuruLaunchResolutionResult = {
        launch_id: launchId,
        funnel_role: null,
        strategy: 'last_attribution',
      };

      // BR-AUDIT-001: structured log for audit trail; no PII emitted
      safeLog('info', {
        event: 'guru_launch_resolved',
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
  const result: GuruLaunchResolutionResult = {
    launch_id: null,
    funnel_role: null,
    strategy: 'none',
  };

  // BR-AUDIT-001: structured log for audit trail; no PII emitted
  safeLog('info', {
    event: 'guru_launch_resolved',
    workspace_id: workspaceId,
    product_id: productId ?? null,
    strategy: result.strategy,
    launch_id: result.launch_id,
    funnel_role: result.funnel_role,
  });

  return result;
}
