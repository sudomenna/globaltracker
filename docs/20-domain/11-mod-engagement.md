# MOD-ENGAGEMENT — Survey, ICP scoring, webinar

## 1. Identidade

- **ID:** MOD-ENGAGEMENT
- **Tipo:** Supporting
- **Dono conceitual:** MARKETER (qualificação) + DOMAIN (regras de score)

## 2. Escopo

### Dentro
- `lead_survey_responses` (respostas a surveys de qualificação).
- `lead_icp_scores` (score ICP versionado por `score_version`).
- `webinar_attendance` (presença em aulas/webinar).
- Regras configuráveis de scoring por workspace (não modelo estatístico — Fase 6+).

### Fora
- Modelo estatístico de qualificação (fora de escopo total).
- IA / NLP em respostas livres (fora de escopo Fase 1-3; possível Fase 6).

## 3. Entidades

### LeadSurveyResponse
- `id`, `workspace_id`, `lead_id`
- `launch_id` (FK opcional)
- `survey_id` (text — operador define)
- `survey_version`
- `response` (jsonb — pares pergunta/resposta)
- `ts`

### LeadIcpScore
- `id`, `workspace_id`, `lead_id`
- `launch_id` (FK opcional)
- `score_version` (text — versionamento de regras)
- `score_value` (numeric)
- `is_icp` (boolean)
- `inputs` (jsonb — campos avaliados)
- `evaluated_at`

### WebinarAttendance
- `id`, `workspace_id`, `lead_id`, `launch_id`
- `session_id` (text)
- `joined_at`, `left_at`
- `watched_seconds`
- `max_watch_marker` (`25%` / `50%` / `75%` / `100%` / `completed`)
- `source` (`webhook:webinarjam` / `webhook:zoom` / `manual`)
- `unique (workspace_id, lead_id, session_id)`

## 4. Relações

- `LeadSurveyResponse N—1 Lead`
- `LeadIcpScore N—1 Lead`
- `WebinarAttendance N—1 Lead`
- Todas N—1 Launch (FK opcional)

## 5. Estados

Sem state machine — entidades são append-only ou upsert simples.

ICP scoring pode ser re-calculado quando `score_version` mudar — gera novo row com `score_version` nova.

## 6. Transições válidas

- Survey response: insert append-only via webhook do Typeform/Tally (Fase 3+).
- ICP score: novo row a cada avaliação; histórico preservado por `score_version`.
- Webinar attendance: upsert via webhook do WebinarJam (Fase 3+).

## 7. Invariantes

- **INV-ENGAGEMENT-001 — Webinar attendance único por `(workspace_id, lead_id, session_id)`.** Constraint. Testável.
- **INV-ENGAGEMENT-002 — `score_version` em `lead_icp_scores` é não-vazio.** Validador. Testável.
- **INV-ENGAGEMENT-003 — `score_value` numérico finito (não NaN, não Infinity).** Constraint. Testável.
- **INV-ENGAGEMENT-004 — `survey_id` é não-vazio.** Validador. Testável.
- **INV-ENGAGEMENT-005 — `watched_seconds` ≥ 0.** Constraint. Testável.

## 8. BRs relacionadas

- `BR-ENGAGEMENT-001` — Score ICP é versionado; mudança de regra gera score novo, não atualiza score antigo.

## 9. Contratos consumidos

- `MOD-IDENTITY` (lead_id resolvido).
- `MOD-LAUNCH` (associação opcional).

## 10. Contratos expostos

- `recordSurveyResponse(lead_id, launch_id, survey_id, response, ctx): Result<LeadSurveyResponse>`
- `evaluateIcp(lead_id, launch_id, score_version, ctx): Result<LeadIcpScore>`
- `recordWebinarAttendance(lead_id, launch_id, session_id, attendance, ctx): Result<WebinarAttendance>`
- `getLatestIcpScore(lead_id, launch_id): Promise<LeadIcpScore | null>`

## 11. Eventos de timeline emitidos

- `TE-SURVEY-COMPLETED`
- `TE-ICP-SCORED`
- `TE-WEBINAR-JOINED`
- `TE-WEBINAR-WATCHED-MARKER` (com `max_watch_marker`)

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/lead_survey_response.ts`
- `packages/db/src/schema/lead_icp_score.ts`
- `packages/db/src/schema/webinar_attendance.ts`
- `apps/edge/src/lib/engagement.ts`
- `apps/edge/src/routes/webhooks/typeform.ts`
- `apps/edge/src/routes/webhooks/tally.ts`
- `apps/edge/src/routes/webhooks/webinarjam.ts`
- `tests/unit/engagement/**`
- `tests/integration/engagement/**`

**Lê:**
- `apps/edge/src/lib/lead-resolver.ts`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-IDENTITY`, `MOD-LAUNCH`, `MOD-FUNNEL` (cria stage `survey_completed`, `watched_class_*` quando ICP-qualified).
**Proibidas:** `MOD-DISPATCH` direto (eventos de engajamento podem virar dispatch jobs via `MOD-EVENT`, mas não diretamente).

## 14. Test harness

- `tests/unit/engagement/score-versioning.test.ts` — INV-ENGAGEMENT-002.
- `tests/integration/engagement/webinar-upsert.test.ts` — INV-ENGAGEMENT-001.
- `tests/integration/engagement/icp-creates-stage.test.ts` — `is_icp=true` cria stage `icp_qualified`.
