/**
 * leads-filter.ts — WHERE-fragment builders for the leads list/count/export
 * queries that need to filter by tag presence/absence.
 *
 * Why a dedicated module:
 *   - Keeps `leads-queries.ts` focused on query orchestration.
 *   - Single source of truth for the EXISTS-subquery pattern (avoids the
 *     "Join multiplication bug" — see MEMORY.md). INNER JOIN on `lead_tags`
 *     would multiply each lead row by its tag count, silently inflating
 *     counts and breaking keyset pagination.
 *
 * BR-IDENTITY: every subquery is anchored on `workspace_id` explicitly,
 *   not relying on RLS alone in nested SQL contexts.
 */

import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

export interface TagFilterClause {
  /** true → tag must be present (EXISTS); false → tag must be absent (NOT EXISTS) */
  has: boolean;
  /** tag_name as stored in lead_tags.tag_name (operator-defined, no enum) */
  tag: string;
}

export interface TagFilter {
  /** Combinator for the clause list. 'and' → ALL clauses; 'or' → ANY clause. */
  op: 'and' | 'or';
  clauses: TagFilterClause[];
}

/**
 * Zod validators for the tag-filter wire format. Co-located with the SQL
 * builder so every consumer (GET /v1/leads via base64url query param, plus
 * the bulk endpoints in routes/leads-timeline.ts and routes/leads-tags.ts
 * that accept it as a JSON body field) parses the same shape.
 *
 * `op` defaults to 'and' for ergonomics — clients can omit it when there is
 * a single clause and the choice is moot. `z.infer<typeof TagFilterSchema>`
 * yields the same runtime shape as the `TagFilter` interface above (after
 * parsing the default fills `op`).
 *
 * Clause cap is 20 to avoid pathological EXISTS-subquery fan-out in
 * `buildTagFilterWhere` (each clause adds a correlated subquery).
 */
export const TagFilterClauseSchema = z.object({
  has: z.boolean(),
  tag: z.string().min(1).max(120),
});

export const TagFilterSchema = z.object({
  op: z.enum(['and', 'or']).default('and'),
  clauses: z.array(TagFilterClauseSchema).min(1).max(20),
});

/**
 * Build the WHERE fragment that filters leads by presence/absence of tags.
 *
 * SEMPRE EXISTS / NOT EXISTS — nunca JOIN — to avoid multiplying lead rows
 * by the number of tags they own (see MEMORY.md "Join multiplication bug
 * pattern"). One subquery per clause, combined with AND or OR.
 *
 * BR-IDENTITY: workspace_id is an explicit anchor inside each subquery
 * (parameterized as ::uuid). Do not trust RLS alone for inner queries.
 *
 * @param filter        Validated filter shape ({op, clauses[]}). `null`,
 *                      `undefined`, or empty `clauses` produces `null`.
 * @param workspaceId   UUID of the current workspace (string; parameterized
 *                      as ::uuid in SQL).
 * @param leadIdColumn  Optional SQL fragment pointing to the lead id column
 *                      in the outer query. Defaults to `leads.id`. Callers
 *                      that scope tables (e.g. `l.id` via alias) should pass
 *                      it explicitly.
 * @returns A SQL fragment ready to drop into `and(...)`/`or(...)`, or
 *          `null` if the filter is empty (caller should skip the push).
 */
export function buildTagFilterWhere(
  filter: TagFilter | undefined | null,
  workspaceId: string,
  leadIdColumn?: SQL,
): SQL | null {
  if (!filter || filter.clauses.length === 0) return null;

  const idCol = leadIdColumn ?? sql`leads.id`;

  const parts: SQL[] = filter.clauses.map((cl) => {
    // BR-IDENTITY: workspace_id anchored inside each subquery — not relying on
    // outer RLS to filter the nested scan.
    const inner = sql`SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${idCol} AND lead_tags.workspace_id = ${workspaceId}::uuid AND lead_tags.tag_name = ${cl.tag}`;
    return cl.has ? sql`EXISTS (${inner})` : sql`NOT EXISTS (${inner})`;
  });

  const sep = filter.op === 'or' ? sql` OR ` : sql` AND `;
  return sql`(${sql.join(parts, sep)})`;
}
