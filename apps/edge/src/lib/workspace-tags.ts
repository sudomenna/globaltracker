/**
 * workspace-tags.ts — Catalog CRUD for workspace_tags (tag metadata).
 *
 * T-TAGS-002 (domain).
 *
 * workspace_tags é o catálogo de metadados de tags por workspace (color,
 * description, soft-delete). A relação com lead_tags é SOFT — match por
 * (workspace_id, name), sem FK rígida (ADR-047). Isso permite:
 *   - lead_tags pré-existentes continuarem válidos sem catálogo.
 *   - blueprints declararem tags antes do operador abrir a UI de catálogo
 *     (auto-registro idempotente via `autoRegisterTag`).
 *
 * BRs / INVs honrados:
 *   - BR-IDENTITY:    todo WHERE inclui workspace_id; RLS dual-mode.
 *   - BR-AUDIT-001:   created_by + created_at sempre populados.
 *   - BR-PRIVACY-001: catálogo não contém PII — apenas metadados de UI.
 *     Seguro logar `tag_name`, `tag_id`, `workspace_id`.
 *   - INV-WORKSPACE-TAG-001: UNIQUE (workspace_id, name); duplicatas viram
 *     `error: 'duplicate'` para o caller (rename) ou ON CONFLICT DO NOTHING
 *     (autoRegisterTag).
 *   - INV-WORKSPACE-TAG-002: created_by segue
 *     `system:auto-registered` | `system:blueprint` | `user:<uuid>`.
 *     Validação de formato é responsabilidade do caller (mesma flexibilidade
 *     de lead_tags.set_by, INV-LEAD-TAG-002).
 *   - INV-WORKSPACE-TAG-003: relação soft com lead_tags — rename precisa
 *     propagar `tag_name` em transação atômica para manter join consistente.
 *
 * Decisões de design:
 *   - `Result<T, E>` (ok/error) em vez de throw para erros esperados (mesmo
 *     padrão de lead-tags.ts setLeadTag).
 *   - `lead_count` é opt-in (`withCount`) porque exige subquery por linha;
 *     listagens default em UI raramente precisam do número exato.
 *   - Rename atômico via `db.transaction(...)` — mesmo helper usado em
 *     funnel-scaffolder.ts e audience.ts.
 */

import type { Db } from '@globaltracker/db';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceTagRow {
  id: string;
  workspaceId: string;
  name: string;
  color: string | null;
  description: string | null;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
  /** Populado apenas quando `listTags({ withCount: true })`. */
  leadCount?: number;
}

/** snake_case row shape returned by `db.execute(sql\`SELECT ...\`)`. */
interface WorkspaceTagDbRow {
  id: string;
  workspace_id: string;
  name: string;
  color: string | null;
  description: string | null;
  created_by: string;
  created_at: Date | string;
  archived_at: Date | string | null;
  lead_count?: number | string;
}

function rowToCamel(row: WorkspaceTagDbRow): WorkspaceTagRow {
  const out: WorkspaceTagRow = {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    color: row.color,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    archivedAt:
      row.archived_at === null || row.archived_at === undefined
        ? null
        : row.archived_at instanceof Date
          ? row.archived_at
          : new Date(row.archived_at),
  };
  if (row.lead_count !== undefined) {
    out.leadCount = typeof row.lead_count === 'string' ? Number(row.lead_count) : row.lead_count;
  }
  return out;
}

/**
 * Returns true when the DB error message indicates a unique constraint violation.
 * Covers Postgres error code 23505 and Drizzle/postgres.js message patterns.
 * (Same heuristic used em raw-events-processor.ts `isUniqueViolation`.)
 */
function isUniqueViolation(message: string): boolean {
  return (
    message.includes('23505') ||
    message.toLowerCase().includes('unique') ||
    message.toLowerCase().includes('duplicate key')
  );
}

// ---------------------------------------------------------------------------
// autoRegisterTag
// ---------------------------------------------------------------------------

/**
 * Idempotent INSERT no catálogo workspace_tags.
 *
 * Chamado por:
 *   - `setLeadTag` (lead-tags.ts) quando uma tag nova é setada num lead
 *     (source = `system:auto-registered`).
 *   - `applyTagRules` (lead-tags.ts) ao aplicar tag_rules de blueprint
 *     (source = `system:blueprint`).
 *   - Service de import / migração / ações manuais (source = `user:<uuid>`).
 *
 * INV-WORKSPACE-TAG-001: ON CONFLICT (workspace_id, name) DO NOTHING garante
 * idempotência — chamadas repetidas com mesmo (workspace, name) não falham
 * nem duplicam a row, e NÃO modificam o `created_by` da row existente.
 *
 * BR-AUDIT-001: created_by + created_at populados (created_at = NOW()
 * server-side, default da coluna).
 *
 * BR-PRIVACY-001: `name` é string de domínio (sem PII).
 */
export async function autoRegisterTag(args: {
  db: Db;
  workspaceId: string;
  name: string;
  source: 'system:auto-registered' | 'system:blueprint' | `user:${string}`;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // INV-WORKSPACE-TAG-001: ON CONFLICT DO NOTHING — idempotente.
    // INV-WORKSPACE-TAG-002: created_by populado com source canônico.
    // BR-AUDIT-001: created_at default NOW() (column default).
    await args.db.execute(sql`
      INSERT INTO workspace_tags (workspace_id, name, created_by)
      VALUES (
        ${args.workspaceId}::uuid,
        ${args.name},
        ${args.source}
      )
      ON CONFLICT (workspace_id, name) DO NOTHING
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
// createTag
// ---------------------------------------------------------------------------

/**
 * Cria uma tag de catálogo a partir de ação do operador. Diferente de
 * `autoRegisterTag`, esta variante:
 *   - Aceita `color` e `description` (autoRegister só popula `name`).
 *   - Devolve a row criada (necessário para a UI exibir a tag recém-criada).
 *   - Retorna `error: 'duplicate'` quando (workspace_id, name) já existe,
 *     em vez de ser silenciosamente idempotente — operador precisa do feedback
 *     para corrigir o nome ou abrir a tag existente.
 *
 * INV-WORKSPACE-TAG-001: duplicate detection via pg error 23505.
 * INV-WORKSPACE-TAG-002: `createdBy` deve seguir `user:<uuid>` (ou similar);
 *   validação de formato é do caller (route layer).
 * BR-AUDIT-001: created_by + created_at populados.
 */
export async function createTag(args: {
  db: Db;
  workspaceId: string;
  name: string;
  color?: string | null;
  description?: string | null;
  createdBy: string;
}): Promise<
  | { ok: true; tag: WorkspaceTagRow }
  | { ok: false; error: 'duplicate' | 'unknown'; message?: string }
> {
  try {
    const result = await args.db.execute(sql`
      INSERT INTO workspace_tags (workspace_id, name, color, description, created_by)
      VALUES (
        ${args.workspaceId}::uuid,
        ${args.name},
        ${args.color ?? null},
        ${args.description ?? null},
        ${args.createdBy}
      )
      RETURNING id, workspace_id, name, color, description, created_by, created_at, archived_at
    `);

    const rows = result as unknown as WorkspaceTagDbRow[];
    const row = rows[0];
    if (!row) {
      // Caso patológico: INSERT sem RETURNING.
      return { ok: false, error: 'unknown', message: 'insert returned no row' };
    }
    return { ok: true, tag: rowToCamel(row) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (isUniqueViolation(message)) {
      // INV-WORKSPACE-TAG-001: conflito (workspace_id, name).
      return { ok: false, error: 'duplicate' };
    }
    return { ok: false, error: 'unknown', message: message.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// updateTag
// ---------------------------------------------------------------------------

/**
 * Atualiza metadados de uma tag de catálogo. Quando `patch.name` está
 * presente, o rename é **atômico** (transação): renomeia em workspace_tags e
 * propaga em lead_tags.tag_name dentro da mesma transação para preservar a
 * relação SOFT (INV-WORKSPACE-TAG-003).
 *
 * Casos:
 *   - Não encontrada / pertence a outro workspace → `error: 'not_found'`.
 *   - Rename colide com tag existente no mesmo workspace → `error: 'duplicate'`
 *     (rollback automático pela transação).
 *   - Só color/description: UPDATE simples sem transação.
 *
 * INV-WORKSPACE-TAG-003: rename propaga em lead_tags na mesma TRANSACTION.
 * BR-IDENTITY: WHERE inclui workspace_id em ambos os updates (cross-workspace
 *   leak prohibited).
 * BR-AUDIT-001: created_at/created_by não mudam em UPDATE (proveniência
 *   imutável); apenas metadados editáveis (name/color/description).
 */
export async function updateTag(args: {
  db: Db;
  workspaceId: string;
  tagId: string;
  patch: {
    name?: string;
    color?: string | null;
    description?: string | null;
  };
}): Promise<
  | { ok: true; tag: WorkspaceTagRow }
  | { ok: false; error: 'not_found' | 'duplicate' | 'unknown'; message?: string }
> {
  const { name, color, description } = args.patch;
  const wantsRename = name !== undefined;

  // No-op patch: nada a fazer. Não chamamos o DB; devolvemos não-encontrada
  // somente se a row existir? Mantemos simples: faz SELECT only.
  if (!wantsRename && color === undefined && description === undefined) {
    try {
      const sel = await args.db.execute(sql`
        SELECT id, workspace_id, name, color, description, created_by, created_at, archived_at
        FROM workspace_tags
        WHERE id = ${args.tagId}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `);
      const rows = sel as unknown as WorkspaceTagDbRow[];
      const row = rows[0];
      if (!row) return { ok: false, error: 'not_found' };
      return { ok: true, tag: rowToCamel(row) };
    } catch (err) {
      return {
        ok: false,
        error: 'unknown',
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      };
    }
  }

  // ---- Caminho 1: sem rename → UPDATE simples (sem transação) -----------
  if (!wantsRename) {
    try {
      const result = await args.db.execute(sql`
        UPDATE workspace_tags
        SET
          color = ${color === undefined ? sql`color` : sql`${color}`},
          description = ${description === undefined ? sql`description` : sql`${description}`}
        WHERE id = ${args.tagId}::uuid
          AND workspace_id = ${args.workspaceId}::uuid
        RETURNING id, workspace_id, name, color, description, created_by, created_at, archived_at
      `);
      const rows = result as unknown as WorkspaceTagDbRow[];
      const row = rows[0];
      if (!row) return { ok: false, error: 'not_found' };
      return { ok: true, tag: rowToCamel(row) };
    } catch (err) {
      return {
        ok: false,
        error: 'unknown',
        message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      };
    }
  }

  // ---- Caminho 2: rename → TRANSACTION atômica --------------------------
  // INV-WORKSPACE-TAG-003: lock pessimista na row do catálogo, depois
  // propaga rename em lead_tags. Postgres garante atomicidade do COMMIT.
  try {
    const newName = name as string;
    const tag = await args.db.transaction(async (tx) => {
      // SELECT ... FOR UPDATE para travar a row durante o rename.
      const lockRes = await tx.execute(sql`
        SELECT name
        FROM workspace_tags
        WHERE id = ${args.tagId}::uuid
          AND workspace_id = ${args.workspaceId}::uuid
        FOR UPDATE
      `);
      const lockRows = lockRes as unknown as Array<{ name: string }>;
      const current = lockRows[0];
      if (!current) {
        // Lança erro especial; tratado fora da transaction.
        throw new TagUpdateError('not_found');
      }
      const oldName = current.name;

      // UPDATE no catálogo. Se collide com outro (workspace_id, name) →
      // erro de unique (23505), capturado fora.
      const updRes = await tx.execute(sql`
        UPDATE workspace_tags
        SET
          name = ${newName},
          color = ${color === undefined ? sql`color` : sql`${color}`},
          description = ${description === undefined ? sql`description` : sql`${description}`}
        WHERE id = ${args.tagId}::uuid
          AND workspace_id = ${args.workspaceId}::uuid
        RETURNING id, workspace_id, name, color, description, created_by, created_at, archived_at
      `);
      const updRows = updRes as unknown as WorkspaceTagDbRow[];
      const updated = updRows[0];
      if (!updated) {
        throw new TagUpdateError('not_found');
      }

      // Propagação em lead_tags — só se o nome de fato mudou. Caso o
      // operador "renomeie" para o mesmo nome, pulamos o UPDATE (evita
      // bumpar set_at desnecessariamente — mas como não tocamos set_at
      // aqui, é só economia de I/O).
      if (oldName !== newName) {
        // INV-WORKSPACE-TAG-003: propaga match soft.
        // BR-IDENTITY: workspace_id no WHERE.
        await tx.execute(sql`
          UPDATE lead_tags
          SET tag_name = ${newName}
          WHERE workspace_id = ${args.workspaceId}::uuid
            AND tag_name = ${oldName}
        `);
      }

      return rowToCamel(updated);
    });

    return { ok: true, tag };
  } catch (err) {
    if (err instanceof TagUpdateError) {
      return { ok: false, error: err.code };
    }
    const message = err instanceof Error ? err.message : 'unknown';
    if (isUniqueViolation(message)) {
      // Rename colidiu com tag existente no mesmo workspace.
      return { ok: false, error: 'duplicate' };
    }
    return { ok: false, error: 'unknown', message: message.slice(0, 200) };
  }
}

/** Sentinela interna usada para sinalizar erros da transação sem mensagem leak. */
class TagUpdateError extends Error {
  constructor(public readonly code: 'not_found') {
    super(code);
    this.name = 'TagUpdateError';
  }
}

// ---------------------------------------------------------------------------
// archiveTag
// ---------------------------------------------------------------------------

/**
 * Soft-delete da tag de catálogo (workspace_tags.archived_at = NOW()).
 *
 * Quando `cascade = true`, também REMOVE (DELETE) as lead_tags com mesmo
 * tag_name no workspace — útil quando operador quer remover a tag de todos
 * os leads. Sem cascade, lead_tags permanecem (relação soft, ADR-047) e
 * tag continua "visível" como nome em lead_tags mesmo arquivada no catálogo.
 *
 * Atômico: archive + cascade rodam em transação para evitar estado parcial.
 *
 * Retorno:
 *   - archived = false se a tag não existe ou já estava arquivada.
 *   - cascaded = nº de lead_tags removidas (0 quando cascade=false).
 *
 * BR-IDENTITY: workspace_id no WHERE.
 * INV-WORKSPACE-TAG-003: relação soft preservada (cascade é opt-in).
 */
export async function archiveTag(args: {
  db: Db;
  workspaceId: string;
  tagId: string;
  cascade: boolean;
}): Promise<
  | { ok: true; archived: boolean; cascaded: number }
  | { ok: false; error: string }
> {
  try {
    const result = await args.db.transaction(async (tx) => {
      const archRes = await tx.execute(sql`
        UPDATE workspace_tags
        SET archived_at = NOW()
        WHERE id = ${args.tagId}::uuid
          AND workspace_id = ${args.workspaceId}::uuid
          AND archived_at IS NULL
        RETURNING name
      `);
      const archRows = archRes as unknown as Array<{ name: string }>;
      const row = archRows[0];

      if (!row) {
        // Tag não existe, pertence a outro workspace, ou já estava arquivada.
        return { archived: false, cascaded: 0 };
      }

      let cascaded = 0;
      if (args.cascade) {
        // BR-IDENTITY: workspace_id no WHERE.
        // Conta antes do DELETE — postgres-js não expõe rowCount confiável
        // em DELETE sem RETURNING.
        const delRes = await tx.execute(sql`
          DELETE FROM lead_tags
          WHERE workspace_id = ${args.workspaceId}::uuid
            AND tag_name = ${row.name}
          RETURNING id
        `);
        cascaded = (delRes as unknown as unknown[]).length;
      }

      return { archived: true, cascaded };
    });

    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------
// unarchiveTag
// ---------------------------------------------------------------------------

/**
 * Reativa uma tag arquivada (archived_at IS NOT NULL → NULL).
 *
 * Retorno:
 *   - unarchived = false se a tag não existe, pertence a outro workspace, ou
 *     já estava ativa.
 *
 * BR-IDENTITY: workspace_id no WHERE.
 */
export async function unarchiveTag(args: {
  db: Db;
  workspaceId: string;
  tagId: string;
}): Promise<{ ok: true; unarchived: boolean } | { ok: false; error: string }> {
  try {
    const res = await args.db.execute(sql`
      UPDATE workspace_tags
      SET archived_at = NULL
      WHERE id = ${args.tagId}::uuid
        AND workspace_id = ${args.workspaceId}::uuid
        AND archived_at IS NOT NULL
      RETURNING id
    `);
    const unarchived = (res as unknown as unknown[]).length > 0;
    return { ok: true, unarchived };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------
// listTags
// ---------------------------------------------------------------------------

/**
 * Lista tags do catálogo do workspace, ordenadas alfabeticamente.
 *
 * Opções:
 *   - includeArchived = false (default): oculta tags com archived_at definido.
 *     UI da listagem padrão usa false; tela de "arquivadas" usa true.
 *   - withCount = false (default): pula a subquery COUNT(*) de lead_tags
 *     (perf — uma subquery por linha). Quando true, popula `lead_count`.
 *
 * BR-IDENTITY: workspace_id no WHERE (e na subquery de count).
 */
export async function listTags(args: {
  db: Db;
  workspaceId: string;
  includeArchived?: boolean;
  withCount?: boolean;
}): Promise<WorkspaceTagRow[]> {
  const includeArchived = args.includeArchived ?? false;
  const withCount = args.withCount ?? false;

  const countSelect = withCount
    ? sql`, (
        SELECT COUNT(*)::int FROM lead_tags lt
        WHERE lt.workspace_id = wt.workspace_id
          AND lt.tag_name = wt.name
      ) AS lead_count`
    : sql``;

  const archivedFilter = includeArchived ? sql`` : sql`AND archived_at IS NULL`;

  const res = await args.db.execute(sql`
    SELECT
      id, workspace_id, name, color, description, created_by, created_at, archived_at
      ${countSelect}
    FROM workspace_tags wt
    WHERE workspace_id = ${args.workspaceId}::uuid
    ${archivedFilter}
    ORDER BY name ASC
  `);

  return (res as unknown as WorkspaceTagDbRow[]).map(rowToCamel);
}
