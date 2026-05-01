# WebinarJam Webhook (Fase 3)

## Papel no sistema
Capturar registro, presença, duração e momentos-chave de webinars/aulas para alimentar `webinar_attendance` e `lead_stages` (`watched_class_*`).

## Status

**Fase 3.** Adapter implementado quando audience sync e analytics estiverem prontos.

## Eventos consumidos (in)

| Evento WebinarJam | Mapeia para | Idempotency key |
|---|---|---|
| `webinar.registered` | atualiza `webinar_attendance` (sem `joined_at`) | `webinar_id:attendee_id:registered` |
| `webinar.attended` (joined) | `joined_at` em `webinar_attendance` + `lead_stage='attended_webinar'` | `webinar_id:attendee_id:joined` |
| `webinar.left` | `left_at`, `watched_seconds` | `webinar_id:attendee_id:left` |
| `webinar.replay_watched` | `watched_seconds` adicionais; pode gerar `lead_stage='watched_replay_X%'` | `webinar_id:attendee_id:replay` |

## Endpoint

```
POST /v1/webhook/webinarjam?workspace=<slug>
```

## Assinatura

WebinarJam não tem signature nativa em todas integrações. Estratégias de defesa:
1. Token shared secret obrigatório no payload (header `X-WebinarJam-Token` ou query `token=`).
2. IP allowlist (CIDR de WebinarJam — buscar documentação).
3. Validação básica do payload (campos esperados).

## `event_id` derivation

```
event_id = sha256("webinarjam:" || webinar_id || ":" || attendee_id || ":" || event_type)[:32]
```

## Mapping

| Campo WebinarJam | Campo interno |
|---|---|
| `attendee.email` | `email` |
| `attendee.name` | `name` |
| `webinar_id` | `webinar_attendance.session_id` |
| `time_watched` | `webinar_attendance.watched_seconds` |
| `peak_minute` ou `current_position_pct` | `max_watch_marker` (mapear para `25%`/`50%`/`75%`/`100%`) |

## Associação de lead

1. `metadata.lead_public_id` (se WebinarJam permite hidden field no registration form — verificar).
2. `attendee.email` hash via `lead_aliases`.
3. Fallback: criar lead novo com email.

## Stages emitidos

| `max_watch_marker` | Stage gerado |
|---|---|
| `25%`+ | `watched_class_quarter` |
| `50%`+ | `watched_class_half` |
| `75%`+ | `watched_class_majority` |
| `100%`/`completed` | `watched_class_complete` |

(Stages são recorrentes — `is_recurring=true`.)

## Credenciais

```
WEBINARJAM_WEBHOOK_SECRET
WEBINARJAM_IP_ALLOWLIST (opcional, comma-separated CIDRs)
```

## Adapter

`apps/edge/src/routes/webhooks/webinarjam.ts` + `apps/edge/src/integrations/webinarjam/mapper.ts` (Fase 3).

## Fixtures

`tests/fixtures/webinarjam/`:
- `webinar-registered.json`
- `webinar-attended.json`
- `webinar-left-with-watched-seconds.json`

## Referências

- WebinarJam API/Webhook docs (verificar antes de implementação Fase 3).
