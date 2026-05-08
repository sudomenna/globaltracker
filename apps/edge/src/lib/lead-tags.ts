/**
 * lead-tags.ts — Idempotent lead tag application helpers.
 *
 * T-LEADS-VIEW-002 (domain).
 *
 * lead_tags são atributos binários atemporais por lead, workspace-scoped,
 * complementando lead_stages (progressão monotônica) e events (fatos
 * pontuais). Eventos podem disparar simultaneamente: stage promotion
 * (existente) + tag set (este módulo).
 *
 * Tag rules vivem no funnel_blueprint (`blueprint.tag_rules`). Cada regra
 * casa um event_name (e opcionalmente um filtro `when`) → seta uma tag no
 * lead. Aplicação é idempotente via UNIQUE (workspace_id, lead_id, tag_name)
 * com ON CONFLICT DO NOTHING.
 *
 * BRs / INVs honrados:
 *   - INV-LEAD-TAG-001: UNIQUE (workspace_id, lead_id, tag_name) — duplicatas
 *     são silenciosamente descartadas pelo ON CONFLICT.
 *   - INV-LEAD-TAG-002: set_by segue 'system' | 'user:<uuid>' |
 *     'integration:<name>' | 'event:<event_name>'. Aqui usamos sempre
 *     'event:<event_name>' (proveniência: tag_rule disparada por evento).
 *   - BR-AUDIT-001: set_by + set_at populados em todo INSERT.
 *   - BR-PRIVACY-001: nunca logar PII; lead_id é UUID interno (safe).
 */

import type { Db } from '@globaltracker/db';
import { sql } from 'drizzle-orm';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Types
//
// `TagRule` é inlined aqui em vez de importado de
// `@globaltracker/shared/schemas/funnel-blueprint` porque o pacote
// `@globaltracker/shared` ainda não é dependência declarada de
// `@globaltracker/edge` (mesmo motivo que mantém FunnelBlueprintSchema
// inline em raw-events-processor.ts). A shape espelha exatamente
// `TagRuleSchema` do shared para garantir compatibilidade quando o
// pacote for finalmente puxado.
// ---------------------------------------------------------------------------

export interface TagRuleCondition {
  /** Filtro mais comum: funnel_role do evento (workshop|main_offer|...). */
  funnel_role?: string;
  /** Demais filtros declarativos passam adiante (passthrough no Zod). */
  [key: string]: unknown;
}

export interface TagRule {
  /** Nome do evento (canonical ou `custom:*`). */
  event: string;
  /** Filtro opcional sobre o payload do evento. */
  when?: TagRuleCondition;
  /** Nome da tag a ser setada. */
  tag: string;
}

export interface ApplyTagRulesArgs {
  db: Db;
  workspaceId: string;
  leadId: string;
  eventName: string;
  /** Contexto do evento usado para casar `tag_rule.when` (ex.: funnel_role). */
  eventContext?: TagRuleCondition;
  /** Lista de regras vinda do blueprint. `undefined` ou `[]` → no-op. */
  tagRules: TagRule[] | undefined;
  /** request_id para correlacionar logs (opcional). */
  requestId?: string;
}

export interface ApplyTagRulesResult {
  applied: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// setLeadTag
// ---------------------------------------------------------------------------

/**
 * Idempotent INSERT of a tag for a lead.
 *
 * INV-LEAD-TAG-001: UNIQUE (workspace_id, lead_id, tag_name) — duplicatas
 * são silenciosamente descartadas pelo ON CONFLICT DO NOTHING.
 *
 * INV-LEAD-TAG-002: set_by segue formato canônico
 * ('system'|'user:<uuid>'|'integration:<name>'|'event:<event_name>').
 * Validação de formato é responsabilidade do caller — esta função aceita
 * qualquer string para manter o helper genérico (mesma flexibilidade do DB).
 *
 * BR-AUDIT-001: set_by + set_at sempre populados (set_at via NOW()).
 *
 * Retorna `Result` em vez de throw para erros esperados (ADR — `Result<T,E>`
 * em vez de throw em caminho previsível).
 */
export async function setLeadTag(args: {
  db: Db;
  workspaceId: string;
  leadId: string;
  tagName: string;
  /** Formato canônico: 'system' | 'user:<uuid>' | 'integration:<name>' | 'event:<event_name>'. */
  setBy: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // INV-LEAD-TAG-001: ON CONFLICT DO NOTHING garante idempotência.
    // BR-AUDIT-001: set_by + set_at populados (set_at = NOW() server-side).
    await args.db.execute(sql`
      INSERT INTO lead_tags (workspace_id, lead_id, tag_name, set_by, set_at)
      VALUES (
        ${args.workspaceId}::uuid,
        ${args.leadId}::uuid,
        ${args.tagName},
        ${args.setBy},
        NOW()
      )
      ON CONFLICT (workspace_id, lead_id, tag_name) DO NOTHING
    `);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------
// applyTagRules
// ---------------------------------------------------------------------------

/**
 * Reads tag_rules from a blueprint, filters matches for the given event,
 * and applies all matching tags. Idempotent — failures de uma tag não
 * impedem as demais e são logadas (não bubblam).
 *
 * Match logic:
 *   1. tag_rule.event === eventName (exact match).
 *   2. Se tag_rule.when presente, TODAS as keys precisam casar com
 *      eventContext (ex.: when.funnel_role === eventContext.funnel_role).
 *      Key ausente em eventContext → no match.
 *
 * Retorna contadores aplicado/pulado para observabilidade (não levanta).
 *
 * BR-PRIVACY-001: workspace_id, lead_id, tag_name e event_name são
 * identificadores não-sensíveis (UUIDs internos / strings de domínio) — safe
 * em logs.
 */
export async function applyTagRules(
  args: ApplyTagRulesArgs,
): Promise<ApplyTagRulesResult> {
  if (!args.tagRules || args.tagRules.length === 0) {
    return { applied: 0, skipped: 0 };
  }

  let applied = 0;
  let skipped = 0;

  for (const rule of args.tagRules) {
    // 1) event_name match (exato)
    if (rule.event !== args.eventName) {
      skipped++;
      continue;
    }

    // 2) when conditions: AND lógico, key ausente → no match
    if (rule.when) {
      const ctx = (args.eventContext ?? {}) as Record<string, unknown>;
      let matchesAllConditions = true;
      for (const [key, expectedValue] of Object.entries(rule.when)) {
        if (ctx[key] !== expectedValue) {
          matchesAllConditions = false;
          break;
        }
      }
      if (!matchesAllConditions) {
        skipped++;
        continue;
      }
    }

    // INV-LEAD-TAG-002: set_by = 'event:<event_name>' (proveniência).
    const result = await setLeadTag({
      db: args.db,
      workspaceId: args.workspaceId,
      leadId: args.leadId,
      tagName: rule.tag,
      setBy: `event:${args.eventName}`,
    });

    if (result.ok) {
      applied++;
    } else {
      skipped++;
      // BR-PRIVACY-001: lead_id é UUID interno (não-PII); tag_name é string
      // de domínio definida no blueprint — safe em logs.
      safeLog('warn', {
        event: 'lead_tag_set_failed',
        request_id: args.requestId,
        workspace_id: args.workspaceId,
        lead_id: args.leadId,
        tag_name: rule.tag,
        event_name: args.eventName,
        error: result.error.slice(0, 200),
      });
    }
  }

  return { applied, skipped };
}
