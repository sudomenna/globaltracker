import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// T-TAGS-001: workspace_tags — catálogo de metadados de tags por workspace.
//
// Relação canônica com lead_tags:
//   - lead_tags.tag_name  → texto livre, operator-defined, populado por blueprint
//     tag_rules e integrações externas. SEM FK para esta tabela (ADR-047).
//   - workspace_tags      → catálogo opcional de metadados (cor, descrição,
//     soft-delete). Match por (workspace_id, name) feito em service layer.
//
// Por que NÃO há FK rígida (ADR-047):
//   - Compat retroativa: lead_tags existentes (T-LEADS-VIEW-001, migration 0044)
//     foram criadas sem catálogo; uma FK quebraria essas rows.
//   - Blueprints (`funnel_blueprint.tag_rules[]`) podem declarar tags antes do
//     operador abrir a UI de catálogo. Auto-registro pelo service layer mantém
//     o catálogo sincronizado sem bloquear ingestion.
//   - Sync: helpers em `apps/edge/src/lib/lead-tags.ts` (próxima wave) fazem
//     `autoRegisterTag(workspace_id, name, 'system:auto-registered')` em UPSERT
//     idempotente quando `setLeadTag` encontra `tag_name` novo.
//
// BR-IDENTITY:    workspace_tags é workspace-scoped (RLS dual-mode).
// BR-AUDIT-001:   created_by + created_at sempre populados — proveniência é
//                 parte do contrato.
// BR-PRIVACY-001: catálogo não contém PII (apenas metadados de UI).
//
// INV-WORKSPACE-TAG-001: (workspace_id, name) é único.
//   Enforced via uq_workspace_tags_workspace_name (DB-level unique index).
//
// INV-WORKSPACE-TAG-002: created_by segue padrão
//   `system:auto-registered` | `system:blueprint` | `user:<uuid>`.
//   Validação de formato é responsabilidade do service layer (sem CHECK DB
//   — flexibilidade para novas fontes sem migration; mesmo padrão de
//   lead_tags.set_by, INV-LEAD-TAG-002).
//
// INV-WORKSPACE-TAG-003: relação com lead_tags é SOFT — match por
//   (workspace_id, name), sem FK rígida. Ver ADR-047 acima.

export const workspaceTags = pgTable(
  'workspace_tags',
  {
    // PK: internal UUID
    id: uuid('id').primaryKey().defaultRandom(),

    // Multi-tenant anchor — BR-RBAC-002: RLS enforces app.current_workspace_id
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // Nome canônico da tag — match com lead_tags.tag_name (texto livre,
    // mesmo charset). Unicidade por workspace garantida por
    // uq_workspace_tags_workspace_name.
    name: text('name').notNull(),

    // Cor associada na UI. Formato livre: hex (#rrggbb) ou token do design
    // system (`token:accent`). Sem CHECK DB — controlado em service layer
    // para permitir evolução do design system sem migration.
    color: text('color'),

    // Descrição livre exibida no catálogo de tags do workspace.
    description: text('description'),

    // Proveniência — INV-WORKSPACE-TAG-002:
    //   'user:<uuid>'              → criação manual pelo operador
    //   'system:auto-registered'   → criada por setLeadTag em runtime
    //   'system:blueprint'         → criada por aplicação de blueprint
    //                                (funnel_template.tag_rules)
    createdBy: text('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Soft-delete reversível. NULL = ativa; timestamp = arquivada.
    // Tags arquivadas são ocultadas da UI mas mantêm o catálogo histórico
    // (lead_tags ainda podem apontar para o nome via match soft).
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    // INV-WORKSPACE-TAG-001: unicidade (workspace_id, name)
    uqWorkspaceTagsName: uniqueIndex('uq_workspace_tags_workspace_name').on(
      table.workspaceId,
      table.name,
    ),
    // Lookup mais frequente: "tags ativas do workspace" (listagem na UI).
    // Partial index sobre archived_at IS NULL minimiza tamanho.
    idxActiveByWorkspace: index('idx_workspace_tags_workspace_active')
      .on(table.workspaceId)
      .where(sql`${table.archivedAt} IS NULL`),
  }),
);

export type WorkspaceTag = typeof workspaceTags.$inferSelect;
export type NewWorkspaceTag = typeof workspaceTags.$inferInsert;
