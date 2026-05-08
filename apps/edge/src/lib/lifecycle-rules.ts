/**
 * lifecycle-rules.ts — domain rules for lead lifecycle promotion.
 *
 * Pure types + functions. No I/O, no DB access. Safe to import anywhere.
 *
 * Hierarquia monotônica de lifecycle do lead derivada de compras + funil:
 *   mentorado(4) > aluno(3) > cliente(2) > lead(1) > contato(0)
 *
 * BR-PRODUCT-001: lifecycle hierarchy is monotonic — promotions only, never regressions.
 * BR-PRODUCT-002: NULL category (auto-created product, not yet categorized by operator)
 *                 defaults to 'cliente' — they bought something, so they are at least a
 *                 customer. Operator can re-categorize and trigger backfill later.
 *
 * Hardcoded category → lifecycle map for now. FUTURE-002 (sprint TBD): replace
 * `lifecycleForCategory` body with lookup in
 * `lifecycle_rules(workspace_id, category, lifecycle_status)` table — the
 * function signature already accepts `workspaceId` so callers do not need
 * rewriting when the lookup is migrated to a per-workspace override table.
 *
 * T-PRODUCTS-002.
 */

// ---------------------------------------------------------------------------
// Canonical enums
// ---------------------------------------------------------------------------

export type LifecycleStatus =
  | 'contato'
  | 'lead'
  | 'cliente'
  | 'aluno'
  | 'mentorado';

export type ProductCategory =
  | 'ebook'
  | 'workshop_online'
  | 'webinar'
  | 'curso_online'
  | 'curso_presencial'
  | 'pos_graduacao'
  | 'treinamento_online'
  | 'evento_fisico'
  | 'mentoria_individual'
  | 'mentoria_grupo'
  | 'acompanhamento_individual';

/**
 * All valid LifecycleStatus values, in canonical rank order (low → high).
 * Useful for iteration in tests and UI selectors.
 */
export const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  'contato',
  'lead',
  'cliente',
  'aluno',
  'mentorado',
] as const;

/**
 * All valid ProductCategory values. Order has no semantic meaning — used for
 * iteration in tests and UI dropdowns.
 */
export const PRODUCT_CATEGORIES: readonly ProductCategory[] = [
  'ebook',
  'workshop_online',
  'webinar',
  'curso_online',
  'curso_presencial',
  'pos_graduacao',
  'treinamento_online',
  'evento_fisico',
  'mentoria_individual',
  'mentoria_grupo',
  'acompanhamento_individual',
] as const;

// ---------------------------------------------------------------------------
// Internal rank table — total order for LifecycleStatus
// ---------------------------------------------------------------------------

const LIFECYCLE_RANK: Record<LifecycleStatus, number> = {
  contato: 0,
  lead: 1,
  cliente: 2,
  aluno: 3,
  mentorado: 4,
};

/**
 * Hardcoded category → lifecycle map.
 *
 * Rationale per category bucket:
 *   - cliente: low-ticket digital goods (ebook, workshop online, webinar) —
 *     buyer commitment is light; they are customers but not yet "students".
 *   - aluno: any structured course/training/event (online or presencial) —
 *     purchase implies enrolment in an instructional program.
 *   - mentorado: 1:1 or small-group mentoring/coaching — highest intimacy,
 *     highest ticket.
 *
 * FUTURE-002: replace with lookup in lifecycle_rules table (see file header).
 */
const CATEGORY_TO_LIFECYCLE: Record<ProductCategory, LifecycleStatus> = {
  ebook: 'cliente',
  workshop_online: 'cliente',
  webinar: 'cliente',
  curso_online: 'aluno',
  curso_presencial: 'aluno',
  pos_graduacao: 'aluno',
  treinamento_online: 'aluno',
  evento_fisico: 'aluno',
  mentoria_individual: 'mentorado',
  mentoria_grupo: 'mentorado',
  acompanhamento_individual: 'mentorado',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a product category (or NULL = uncategorized) to the LifecycleStatus
 * that a Purchase of that product justifies.
 *
 * BR-PRODUCT-002: NULL category → 'cliente' (conservative default: a Purchase
 * always implies at least 'cliente'; operator can re-categorize later).
 *
 * The `workspaceId` parameter is currently unused — accepted now so a future
 * per-workspace override table (FUTURE-002) can plug in without changing
 * any call sites.
 */
export function lifecycleForCategory(
  _workspaceId: string,
  category: ProductCategory | null,
): LifecycleStatus {
  // BR-PRODUCT-002: uncategorized products default to 'cliente'.
  if (category === null) return 'cliente';
  return CATEGORY_TO_LIFECYCLE[category];
}

/**
 * Monotonic promote: returns whichever of (current, candidate) has higher rank.
 *
 * BR-PRODUCT-001: lifecycle never regresses — when candidate has lower or
 * equal rank, returns current unchanged. Idempotent: promote(x, x) === x.
 *
 * Total order is defined by LIFECYCLE_RANK; this is a pure max() over that order.
 */
export function promote(
  current: LifecycleStatus,
  candidate: LifecycleStatus,
): LifecycleStatus {
  // BR-PRODUCT-001: only promote when candidate has strictly higher rank.
  return LIFECYCLE_RANK[candidate] > LIFECYCLE_RANK[current]
    ? candidate
    : current;
}

/**
 * Numeric rank of a LifecycleStatus, useful for SQL CASE expressions, sorting,
 * and analytics. 0 (contato) ... 4 (mentorado).
 */
export function lifecycleRank(status: LifecycleStatus): number {
  return LIFECYCLE_RANK[status];
}

/**
 * Type guard for LifecycleStatus. Use at boundaries (DB row → typed enum).
 */
export function isLifecycleStatus(value: unknown): value is LifecycleStatus {
  return (
    typeof value === 'string' &&
    (LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Type guard for ProductCategory. Use at boundaries (DB row, webhook payload).
 */
export function isProductCategory(value: unknown): value is ProductCategory {
  return (
    typeof value === 'string' &&
    (PRODUCT_CATEGORIES as readonly string[]).includes(value)
  );
}
