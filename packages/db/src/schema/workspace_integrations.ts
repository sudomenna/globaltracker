import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// BR-PRIVACY-001: guru_api_token é segredo externo (token do painel Digital Manager Guru).
// Não logar, não incluir em respostas de API, não serializar em audit payloads.
// BR-WEBHOOK-001 (Guru inbound): token é validado no Edge antes de processar payload.

export const workspaceIntegrations = pgTable('workspace_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),

  // INV-WI-001: one-to-one com workspace (uq_workspace_integrations_workspace_id).
  // onDelete cascade: remover workspace remove credenciais associadas.
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' })
    .unique(),

  // Digital Manager Guru webhook authentication token.
  // chk_workspace_integrations_guru_token_length: quando não nulo, length = 40.
  // Nullable — workspace sem integração Guru simplesmente não tem valor aqui.
  // Futuras colunas por provider (meta_capi_token, ga4_api_secret, etc.)
  // devem seguir o mesmo padrão: nullable, com check de formato específico.
  guruApiToken: text('guru_api_token'),

  // SendFlow webhook authentication token (header `sendtok`).
  // T-13-011 / migration 0035. Length 16-200 (formato observado: 40 hex
  // uppercase). Constant-time compare na app layer (sendflow.ts).
  // BR-PRIVACY-001: nunca logado.
  sendflowSendtok: text('sendflow_sendtok'),

  // Google Ads OAuth refresh_token, criptografado AES-256-GCM workspace-scoped.
  // ADR-028 (refinado) / T-14-002 / migration 0038. Length 50-2048 (chk_*_length).
  // Padrão consistente com guruApiToken e sendflowSendtok.
  // BR-PRIVACY-001: nunca logado, nunca retornado em responses (UI usa flag has_token).
  googleAdsRefreshTokenEnc: text('google_ads_refresh_token_enc'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WorkspaceIntegration = typeof workspaceIntegrations.$inferSelect;
export type NewWorkspaceIntegration = typeof workspaceIntegrations.$inferInsert;
