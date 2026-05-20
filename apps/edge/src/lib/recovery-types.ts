/**
 * recovery-types.ts — Shared TypeScript types for the recovery cadence.
 *
 * T-RECOVERY-002 (domain, Wave 2).
 *
 * Centraliza tipos consumidos pelo job-creator e pelo sender. Mantido em
 * arquivo dedicado para evitar circular imports entre `recovery-job-creator.ts`
 * e `recovery-sender.ts`, e para que a UI/edge layer (W3) possa reaproveitar
 * as shapes sem puxar lógica de DB.
 *
 * BR-PRIVACY-001: nenhum tipo aqui carrega PII em claro — apenas IDs internos,
 * counters e shape de payload sanitizado.
 */

// ---------------------------------------------------------------------------
// Schema de campaign.steps[] (lido do jsonb por job-creator/sender)
// ---------------------------------------------------------------------------

/**
 * Item de cadência em `recovery_campaigns.steps[]`. Cada step descreve um
 * envio a ser agendado N minutos após o trigger.
 *
 * INV-RECOVERY-CAMPAIGN-002: validação Zod no service layer (W3); aqui é
 * apenas type-shape para leitura tipada.
 */
export interface RecoveryCampaignStep {
  /** Offset em minutos desde o trigger (received_at do InitiateCheckout). */
  delay_min: number;
  /** UUID em `recovery_templates.id`. */
  template_id: string;
}

// ---------------------------------------------------------------------------
// Schema de template.body_params / url_button_params (jsonb)
// ---------------------------------------------------------------------------

/**
 * Slot de placeholder no template Meta/Unnichat.
 *
 * INV-RECOVERY-TEMPLATE-002: cada item segue
 *   `{ type: 'contactName' | 'text', fallback?: string }`.
 *
 * O sender resolve dinamicamente cada slot e converte para
 * `{ type: 'text', text }` antes de POST na Unnichat (API só aceita
 * `type='text'` no payload final).
 */
export interface RecoveryTemplateSlot {
  /**
   * Tipo lógico do slot — define como o sender resolve o valor:
   *   - 'contactName' → primeiro nome do customer (fallback se ausente)
   *   - 'text'        → usa `fallback` direto (com substituição de tokens
   *                     como `${offer_hash}` quando aplicável)
   */
  type: 'contactName' | 'text' | string;
  /** Valor default quando o resolvedor não consegue extrair do evento. */
  fallback?: string;
}

// ---------------------------------------------------------------------------
// Resultados expostos pelos helpers (consumidos pelas rotas/cron na W3)
// ---------------------------------------------------------------------------

export interface CreatePendingJobsResult {
  workspaceId: string;
  /** Quantos jobs foram efetivamente inseridos (RETURNING id). */
  created: number;
  /**
   * Quantos eventos elegíveis foram observados pela query. Pode ser >= created
   * quando o ON CONFLICT DO NOTHING descarta duplicatas.
   */
  scanned: number;
}

export interface SendResult {
  workspaceId: string;
  sent: number;
  failed: number;
  suppressed: number;
  /**
   * Jobs que estavam `queued + scheduled_for<=NOW()` mas cujo
   * `NOW() AT TIME ZONE tz` caiu fora da janela [start, end]. O SQL já
   * filtra esses fora; este contador é incrementado apenas se o sender
   * precisar pular um job em memória (ex.: race entre query e envio).
   */
  skippedWindow: number;
}

// ---------------------------------------------------------------------------
// Unnichat dispatch (HTTP boundary)
// ---------------------------------------------------------------------------

/**
 * Payload de parâmetro do template no formato Unnichat (já resolvido).
 * A API da Unnichat exige `type='text'` em todos os slots do payload final,
 * independentemente do `type` lógico no template.
 */
export interface UnnichatTemplateParam {
  type: 'text';
  text: string;
}

export interface UnnichatDispatchInput {
  /**
   * Header Authorization completo. Já inclui o prefixo "Bearer " — passe
   * direto como `Authorization: input.apiKey`. NÃO concatene "Bearer "
   * novamente.
   */
  apiKey: string;
  /** Phone E.164 sem '+', apenas dígitos (ex: "5511999999999"). */
  phone: string;
  /** ID do template aprovado no Meta/Unnichat. */
  unnichatTemplateId: string;
  bodyParameters: UnnichatTemplateParam[];
  urlButtonParameters: UnnichatTemplateParam[];
}

export interface UnnichatDispatchResult {
  /** True quando o HTTP status foi 2xx. */
  ok: boolean;
  /** HTTP status code (0 quando erro de rede). */
  status: number;
  /** ID retornado pela API quando ok (procurado em messageId | id | message_id). */
  messageId?: string;
  /**
   * Body parseado e SANITIZADO (sem PII). Quando o JSON não parsa, usa o
   * texto bruto truncado. BR-PRIVACY-001.
   */
  body: unknown;
  /** Mensagem de erro humana (network / non-2xx / parse). */
  error?: string;
}
