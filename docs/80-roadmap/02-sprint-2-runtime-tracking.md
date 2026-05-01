# Sprint 2 — Runtime de tracking confiável (parte A da Fase 2)

## Duração estimada
2-3 semanas.

## Objetivo
Tracker.js v0 + ingestion processor funcional + emissão real de `lead_token` + cookie `__ftk` + reidentificação em retornos.

## Pré-requisitos
- Sprint 1 completo (schema + endpoints fast accept funcionais).
- OQ-004 (Turnstile vs honeypot) decidida.

## Critério de aceite global

- [ ] `tracker.js` build < 15 KB gz; instalação manual em LP de teste.
- [ ] Ingestion processor consome `raw_events`, normaliza, cria `events` + `lead_attribution` + `lead_stages` + `dispatch_jobs`.
- [ ] `lead_token` real emitido por `/v1/lead`; cookie `__ftk` setado e lido.
- [ ] FLOW-07 (lead retornante) E2E verde — Meta CAPI dispatch enriquecido server-side.
- [ ] Lead merge automático em FLOW-08 testado.
- [ ] Bot mitigation ativa em `/v1/lead` (honeypot + timing + Turnstile decisão de OQ-004).

## T-IDs (alto nível — detalhamento ao iniciar sprint)

- T-2-001 a T-2-005: tracker.js core (init, capture cookies, decorate, identify, page).
- T-2-006: ingestion processor real.
- T-2-007: lead-resolver com merge.
- T-2-008: emissão de lead_token real + cookie.
- T-2-009: bot mitigation.
- T-2-010: middleware `lead-token` validation.
- T-2-011: Pixel coexist policy enforcement no tracker.
- T-2-012: E2E FLOW-02, FLOW-07, FLOW-08.

ETA: detalhar T-IDs em ondas quando Sprint 1 finalizar.
