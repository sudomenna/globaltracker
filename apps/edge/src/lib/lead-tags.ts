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
import { autoRegisterTag } from './workspace-tags.js';

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

      // T-TAGS-002: tag aplicada via tag_rule do blueprint → sincroniza o
      // catálogo workspace_tags (auto-registro idempotente). Falha do
      // autoRegister NÃO bloqueia o contador `applied` e NÃO bubbla:
      // ingestion de eventos não pode 500ar por divergência de catálogo.
      // INV-WORKSPACE-TAG-002: source = 'system:blueprint' (proveniência).
      const reg = await autoRegisterTag({
        db: args.db,
        workspaceId: args.workspaceId,
        name: rule.tag,
        source: 'system:blueprint',
      });
      if (!reg.ok) {
        // BR-PRIVACY-001: tag_name + workspace_id são domain ids — safe em log.
        safeLog('warn', {
          event: 'auto_register_tag_failed',
          request_id: args.requestId,
          workspace_id: args.workspaceId,
          tag_name: rule.tag,
          source: 'system:blueprint',
          error: reg.error.slice(0, 200),
        });
      }
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

// ---------------------------------------------------------------------------
// unsetLeadTag — T-TAGS-002
// ---------------------------------------------------------------------------

/**
 * Remove uma tag específica de um lead. NOT-found não é erro — apenas
 * `removed: false`. Idempotente: chamadas repetidas são no-op após a primeira.
 *
 * INV-LEAD-TAG-001: UNIQUE garante que cada (workspace, lead, tag) tem no
 * máximo uma row; DELETE remove ≤ 1.
 * BR-IDENTITY: workspace_id e lead_id no WHERE (cross-workspace leak proibido).
 */
export async function unsetLeadTag(args: {
  db: Db;
  workspaceId: string;
  leadId: string;
  tagName: string;
}): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
  try {
    // Usamos RETURNING para extrair rowCount de forma portátil — postgres-js
    // não expõe rowCount confiável em DELETE sem RETURNING.
    const res = await args.db.execute(sql`
      DELETE FROM lead_tags
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND lead_id = ${args.leadId}::uuid
        AND tag_name = ${args.tagName}
      RETURNING id
    `);
    const removed = (res as unknown as unknown[]).length > 0;
    return { ok: true, removed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------
// bulkApplyLeadTagsByIds — T-TAGS-002
// ---------------------------------------------------------------------------

/**
 * Aplica um conjunto de tags a um conjunto de leads (produto cartesiano).
 *
 * Implementação: uma única INSERT ... SELECT com unnest(leadIds[]) ×
 * unnest(tagNames[]). Idempotente via ON CONFLICT DO NOTHING.
 *
 *   applied = nº de rows inseridas (rowCount via RETURNING id)
 *   skipped = (leadIds × tagNames) - applied
 *
 * INV-LEAD-TAG-001: ON CONFLICT DO NOTHING — duplicatas viram `skipped`.
 * INV-LEAD-TAG-002: `setBy` segue formato canônico — validação de formato é
 *   do caller (route layer). Helper aceita string para flexibilidade.
 * BR-AUDIT-001: set_by + set_at populados (NOW() server-side).
 * BR-IDENTITY: workspace_id fixo em todas as rows inseridas.
 *
 * @param requestId apenas para correlação de logs (não persistido).
 */
export async function bulkApplyLeadTagsByIds(args: {
  db: Db;
  workspaceId: string;
  leadIds: string[];
  tagNames: string[];
  setBy: string;
  requestId?: string;
}): Promise<{ applied: number; skipped: number }> {
  if (args.leadIds.length === 0 || args.tagNames.length === 0) {
    return { applied: 0, skipped: 0 };
  }

  const expected = args.leadIds.length * args.tagNames.length;

  try {
    // Cartesian product via unnest(...) cross join.
    // postgres.js encoda JS arrays como text[]/uuid[] quando o cast é
    // explícito (::uuid[] / ::text[]).
    const res = await args.db.execute(sql`
      INSERT INTO lead_tags (workspace_id, lead_id, tag_name, set_by, set_at)
      SELECT
        ${args.workspaceId}::uuid,
        l.lead_id::uuid,
        t.tag_name,
        ${args.setBy},
        NOW()
      FROM unnest(${args.leadIds}::uuid[]) AS l(lead_id)
      CROSS JOIN unnest(${args.tagNames}::text[]) AS t(tag_name)
      ON CONFLICT (workspace_id, lead_id, tag_name) DO NOTHING
      RETURNING id
    `);
    const applied = (res as unknown as unknown[]).length;
    return { applied, skipped: expected - applied };
  } catch (err) {
    // BR-PRIVACY-001: workspace_id + counts são safe; lead_ids são UUIDs
    // internos mas evitamos logar a lista inteira (tamanho indefinido).
    safeLog('error', {
      event: 'bulk_apply_lead_tags_failed',
      request_id: args.requestId,
      workspace_id: args.workspaceId,
      lead_ids_count: args.leadIds.length,
      tag_names_count: args.tagNames.length,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    // Erro é caminho excepcional; retornamos contadores neutros para o caller
    // decidir. Mantemos a assinatura simples (sem Result) porque a semântica
    // "applied=0, skipped=expected" já é informativa.
    return { applied: 0, skipped: expected };
  }
}

// ---------------------------------------------------------------------------
// bulkUnsetLeadTagsByIds — T-TAGS-002
// ---------------------------------------------------------------------------

/**
 * Remove um conjunto de tags de um conjunto de leads (DELETE em lote).
 *
 *   removed = rowCount (via RETURNING id).
 *
 * BR-IDENTITY: workspace_id no WHERE.
 * Idempotente: combinações inexistentes são no-op (não contam para removed).
 */
export async function bulkUnsetLeadTagsByIds(args: {
  db: Db;
  workspaceId: string;
  leadIds: string[];
  tagNames: string[];
}): Promise<{ removed: number }> {
  if (args.leadIds.length === 0 || args.tagNames.length === 0) {
    return { removed: 0 };
  }

  try {
    const res = await args.db.execute(sql`
      DELETE FROM lead_tags
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND lead_id = ANY(${args.leadIds}::uuid[])
        AND tag_name = ANY(${args.tagNames}::text[])
      RETURNING id
    `);
    return { removed: (res as unknown as unknown[]).length };
  } catch (err) {
    safeLog('error', {
      event: 'bulk_unset_lead_tags_failed',
      workspace_id: args.workspaceId,
      lead_ids_count: args.leadIds.length,
      tag_names_count: args.tagNames.length,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    return { removed: 0 };
  }
}
