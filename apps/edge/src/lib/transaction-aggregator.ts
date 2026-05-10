/**
 * transaction-aggregator.ts — Helper para consolidar Purchase value através
 * de events linkados pelo mesmo transaction_group_id (OnProfit order bumps).
 *
 * Usado pelo dispatcher Meta CAPI / Google Ads / GA4 quando o event é o produto
 * principal de uma transação OnProfit que pode ter order bumps. Ver:
 *   memory/project_dispatch_consolidation_pattern.md
 *
 * BR-DISPATCH-007 (a documentar): Purchase events com mesmo transaction_group_id
 * representam a mesma compra do ponto de vista comercial; dispatch externo deve
 * consolidar value para evitar fragmentar ROAS no algoritmo de bidding.
 *
 * BR-PRIVACY-001: nenhum log de PII; apenas IDs internos e contadores.
 */

import type { Db } from '@globaltracker/db';
import { events } from '@globaltracker/db';
import { and, eq, sql } from 'drizzle-orm';
import { safeLog } from '../middleware/sanitize-logs.js';

export type AggregateResult = {
  /** Soma de custom_data.amount de todos os events do grupo. Em currency units. */
  aggregatedAmount: number;
  /** Quantos events somados (1 = só o evento corrente, sem agregação). */
  eventCount: number;
  /** True quando havia mais de 1 event no grupo (consolidação aplicada). */
  isAggregated: boolean;
};

/**
 * Soma `custom_data.amount` de todos os events com mesmo
 * (workspace_id, transaction_group_id, event_name='Purchase').
 *
 * Quando `transactionGroupId` é null/empty ou nenhum event é encontrado,
 * retorna `currentEventAmount` (degrada graciosamente — nunca falha o dispatch).
 *
 * BR-DISPATCH-007: agregação por transaction_group_id consolida ROAS.
 * BR-PRIVACY-001: nenhum log de PII; apenas IDs internos e contadores.
 */
export async function aggregatePurchaseValueByGroup(args: {
  db: Db;
  workspaceId: string;
  transactionGroupId: string | null | undefined;
  /** Valor do event corrente — usado como fallback. */
  currentEventAmount: number;
}): Promise<AggregateResult> {
  if (!args.transactionGroupId) {
    return {
      aggregatedAmount: args.currentEventAmount,
      eventCount: 1,
      isAggregated: false,
    };
  }

  try {
    // Soma defensiva tolerando jsonb-string legacy (rows pré-deploy ed9a490d).
    // amount pode ser number ou string em rows antigas; CAST para numeric com fallback 0.
    const rows = await args.db
      .select({
        total: sql<string>`COALESCE(SUM(
          CASE
            WHEN jsonb_typeof(${events.customData}) = 'object'
              AND (${events.customData} -> 'amount') IS NOT NULL
            THEN COALESCE(((${events.customData} ->> 'amount')::numeric), 0)
            ELSE 0
          END
        ), 0)::text`,
        count: sql<string>`COUNT(*)::text`,
      })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, args.workspaceId),
          eq(events.eventName, 'Purchase'),
          sql`(${events.customData} ->> 'transaction_group_id') = ${args.transactionGroupId}`,
        ),
      );

    const row = rows[0];
    const total = Number(row?.total ?? '0');
    const count = Number(row?.count ?? '0');

    if (count === 0) {
      // Não deveria acontecer (o event corrente já está no DB), mas defensive.
      return {
        aggregatedAmount: args.currentEventAmount,
        eventCount: 1,
        isAggregated: false,
      };
    }

    return {
      aggregatedAmount: total > 0 ? total : args.currentEventAmount,
      eventCount: count,
      isAggregated: count > 1,
    };
  } catch (err) {
    // Falha em agregar NÃO bloqueia dispatch — degrade para currentEventAmount.
    // BR-PRIVACY-001: apenas IDs internos no log.
    safeLog('warn', {
      event: 'transaction_aggregator_failed',
      workspace_id: args.workspaceId,
      transaction_group_id: args.transactionGroupId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    return {
      aggregatedAmount: args.currentEventAmount,
      eventCount: 1,
      isAggregated: false,
    };
  }
}
