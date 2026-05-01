# Typeform / Tally Webhooks (Fase 3)

## Papel no sistema
Capturar respostas de surveys de qualificação e alimentar `lead_survey_responses` + `lead_icp_scores`.

## Status

**Fase 3.** Implementado junto com `MOD-ENGAGEMENT`.

## Endpoints

```
POST /v1/webhook/typeform?workspace=<slug>
POST /v1/webhook/tally?workspace=<slug>
```

## Assinatura

### Typeform
Header `Typeform-Signature: sha256=<hex>` — HMAC-SHA256 do raw body com `TYPEFORM_WEBHOOK_SECRET`.

### Tally
Header `tally-signature` (validar com docs Tally) ou shared secret no payload.

Validação tempo-constante obrigatória.

## `event_id` derivation

| Plataforma | Derivação |
|---|---|
| Typeform | `sha256("typeform:" || form_response.token)[:32]` |
| Tally | `sha256("tally:" || data.responseId)[:32]` |

## Mapping

### Typeform `form_response`

| Campo Typeform | Campo interno |
|---|---|
| `form_response.hidden.lead_public_id` | associação prioridade 1 |
| `form_response.hidden.launch_public_id` | `launch_id` resolvido |
| `form_response.answers[i].text/email/phone_number/etc.` | `lead_survey_responses.response[question_id]` |
| `form_response.token` | `survey_id` |
| `form_response.definition.id` | `survey_id` (alternativa) |

### Tally `FORM_RESPONSE`

Estrutura similar — hidden fields, fields array.

## Associação de lead

Hierarquia (BR-WEBHOOK-004):
1. `hidden.lead_public_id` (operador deve setar como hidden field no form).
2. Email no payload (campo identificado como email type).
3. Telefone no payload.

## Side effects

1. `recordSurveyResponse(lead_id, launch_id, survey_id, response, ctx)` — insert em `lead_survey_responses`.
2. Se workspace tem regras de ICP (`workspaces.config.icp_rules`): `evaluateIcp()` automaticamente, gera `lead_icp_scores`.
3. Se `is_icp=true`, registra `lead_stage='icp_qualified'` (não-recorrente).
4. TE-SURVEY-COMPLETED-v1 e TE-ICP-SCORED-v1 emitidos.

## Credenciais

```
TYPEFORM_WEBHOOK_SECRET
TALLY_WEBHOOK_SECRET
```

## Adapter

`apps/edge/src/routes/webhooks/typeform.ts` + `apps/edge/src/routes/webhooks/tally.ts` +
`apps/edge/src/integrations/typeform/mapper.ts` + `apps/edge/src/integrations/tally/mapper.ts`.

## Fixtures

`tests/fixtures/typeform/`:
- `form-response.json` (com hidden fields)
- `signature-valid.txt`

`tests/fixtures/tally/`:
- `form-response.json`

## Observabilidade

- `survey_webhook_received_total{platform}`
- `survey_lead_associated_total{platform, method}` (`hidden_field`/`email_match`/`phone_match`/`unassociated`)
- `icp_evaluated_total{is_icp_true_count, false_count}`

## Referências

- [Typeform Webhooks](https://www.typeform.com/developers/webhooks/)
- [Tally Webhooks](https://tally.so/help/webhooks)
