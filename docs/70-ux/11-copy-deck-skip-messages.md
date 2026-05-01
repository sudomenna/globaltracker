# 11 — Copy deck: mensagens de skip e erro humanizadas

> **Status:** Sprint 6. Implementa item D.3 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Traduzir códigos técnicos de `dispatch_jobs.skip_reason`, `dispatch_jobs.status='failed'` (com `error_code`)
e erros HTTP do Edge para mensagens em PT-BR adequadas a MARKETER.

Toda UI que renderiza skip/erro **DEVE** consumir esse dicionário — não inventar texto inline.

Implementação: `apps/control-plane/src/lib/skip-reason-copy.ts` exportando `getSkipCopy(reason): { title, body, action? }`.

---

## 1. Skip reasons (BR-DISPATCH-004)

| `skip_reason` (técnico) | Título UI | Corpo UI | Ação sugerida |
|---|---|---|---|
| `consent_denied:ad_user_data` | Lead negou anúncios | O lead não autorizou uso de dados para anúncios. Eventos de conversão para Meta/Google Ads ficam bloqueados. Analytics segue normalmente. | — |
| `consent_denied:ad_personalization` | Lead negou personalização | O lead permite anúncios mas não personalização. Custom Audiences ficam bloqueadas. | — |
| `consent_denied:analytics` | Lead negou analytics | O lead não autorizou rastreamento analítico. GA4 fica bloqueado. | — |
| `consent_denied:functional` | Lead negou cookies funcionais | Cookies próprios (`__ftk`) não foram setados. Replay de identidade pode falhar. | — |
| `no_user_data` | Sem identificador do lead | Meta exige pelo menos um destes: email, telefone, fbc, fbp, external_id. Nenhum estava disponível. | Verificar captura no formulário |
| `integration_not_configured` | Integração não configurada | Workspace não tem credenciais para esse destino. | [Configurar agora] → `/integrations/:provider` |
| `no_click_id_available` | Sem identificador de clique | Google Ads precisa de `gclid` (clique vindo de campanha Google) para registrar conversão. Esse lead chegou de outra fonte. | — |
| `audience_not_eligible` | Audiência abaixo do mínimo | Meta/Google exigem mínimo de 1.000 pessoas para sincronizar Custom Audience. | [Ver audiência] |
| `archived_launch` | Lançamento arquivado | Eventos de lançamentos arquivados não são despachados a destinos externos. Permanecem no sistema para análise histórica. | — |
| `no_ga4_equivalent` | Evento sem equivalente GA4 | Esse tipo de evento (ex.: `Subscribe`) não tem evento recomendado no GA4. Configure mapeamento custom se necessário. | [Configurar mapeamento] (Fase 6) |

---

## 2. Failed events — `error_code` por destino

### Meta CAPI

| `error_code` | Título UI | Corpo UI | Ação sugerida |
|---|---|---|---|
| `invalid_pixel_id` | Pixel ID inválido | O Pixel ID configurado não foi reconhecido pelo Meta. Verifique se foi copiado corretamente do Meta Business Manager. | [Editar configuração] |
| `invalid_access_token` | Token CAPI inválido ou expirado | O token de acesso da CAPI não foi aceito. Tokens expiram ou podem ser revogados. | [Renovar token] + link para Meta |
| `domain_not_verified` | Domínio não verificado no Meta | O domínio da landing page não está verificado no Meta Business Manager. | [Abrir Domain Verification ↗] |
| `event_dropped_due_to_acceptance_policy` | Evento descartado pelo Meta | Meta descartou o evento (geralmente por iOS 14+ AEM). Verifique priorização de eventos. | [Abrir Aggregated Event Measurement ↗] |
| `rate_limited` | Limite de requests do Meta atingido | O Meta limitou a frequência de envios. Sistema vai retentar automaticamente. | — (auto-retry) |
| `unknown_error` | Erro inesperado do Meta | Meta retornou erro não catalogado. Veja detalhes técnicos abaixo. | [Ver payload] |

### GA4 Measurement Protocol

| `error_code` | Título UI | Corpo UI | Ação sugerida |
|---|---|---|---|
| `invalid_measurement_id` | Measurement ID inválido | O Measurement ID configurado não foi reconhecido pelo GA4. | [Editar configuração] |
| `invalid_api_secret` | API Secret inválido | O API Secret configurado foi rejeitado pelo GA4. | [Renovar API Secret] |
| `validation_failed` | Payload rejeitado pelo GA4 | GA4 rejeitou o evento por validação. Geralmente parâmetros obrigatórios faltando (ex.: `items[]` em e-commerce). | [Ver payload] |

### Google Ads Conversion Upload

| `error_code` | Título UI | Corpo UI | Ação sugerida |
|---|---|---|---|
| `invalid_conversion_action` | Conversion Action inválido | O Conversion Action configurado não existe na conta Google Ads. | [Editar configuração] |
| `gclid_not_found` | Clique não encontrado | O `gclid` não corresponde a nenhum clique conhecido pelo Google. Pode ser muito antigo (>90d). | — |
| `conversion_outside_window` | Conversão fora da janela | A conversão chegou após a janela de atribuição configurada no Google Ads. | [Ver configuração de janela] |

---

## 3. Erros HTTP do Edge (`/v1/events`, `/v1/lead`, `/v1/config`)

| HTTP + `error_code` | Título UI | Corpo UI | Ação sugerida |
|---|---|---|---|
| 400 `validation_error` | Dados inválidos no formulário | O sistema rejeitou o envio por dados malformados. Verifique tipos e campos obrigatórios. | [Ver payload] (operator+) |
| 400 `missing_identifier` | Lead sem email nem telefone | Não foi possível identificar o lead — pelo menos um de email ou telefone é obrigatório. | Verificar formulário |
| 400 `bot_detected` | Tentativa bloqueada (bot) | Sistema anti-bot detectou padrão suspeito no envio (honeypot ou tempo). Provavelmente automatizado. | — |
| 401 `invalid_token` | Token da página inválido | O token configurado no snippet não é mais válido (revogado ou expirado). | [Rotacionar token] |
| 403 `origin_not_allowed` | Domínio não autorizado | Tentativa de tracking veio de domínio fora da lista permitida desta página. | [+ Adicionar domínio] |
| 404 `page_not_found` | Página não encontrada | O `page_public_id` no snippet não corresponde a nenhuma página deste workspace. | Verificar snippet |
| 410 `archived_launch` | Lançamento arquivado | O lançamento desta página foi arquivado e não aceita mais eventos. | [Ver lançamento] |
| 429 `rate_limited` | Limite de envios atingido | Você atingiu o limite de eventos por minuto deste workspace. Reduza frequência ou solicite aumento. | [Ver quota] |

---

## 4. Convenções de redação

- **Tom**: direto, sem culpar o usuário ("não foi possível X" em vez de "você fez Y errado").
- **Termos**: PT-BR. Aceitável manter termos consagrados em inglês: "Pixel", "API", "token", "gclid", "fbp".
- **Comprimento**: título ≤ 6 palavras; corpo ≤ 2 frases.
- **Ação**: usar verbo no infinitivo ("Configurar agora", "Renovar token"). Sem "por favor".
- **Evitar**: jargão de DB (`dispatch_job`, `consent_snapshot`), códigos HTTP no corpo, IDs internos.
- **PII**: zero PII em qualquer mensagem. Se referência ao lead for necessária, usar `lead.public_id` (não email/phone).

---

## 5. Implementação

```ts
// apps/control-plane/src/lib/skip-reason-copy.ts
export interface SkipCopy {
  title: string;
  body: string;
  action?: { label: string; href: string };
}

export function getSkipCopy(reason: string): SkipCopy {
  // ...lookup baseado nas tabelas acima
}

export function getErrorCopy(destination: string, errorCode: string): SkipCopy {
  // ...
}

export function getHttpErrorCopy(status: number, errorCode: string): SkipCopy {
  // ...
}
```

Componente reutilizável: `<SkipReasonBadge reason="consent_denied:ad_user_data" />` em `apps/control-plane/src/components/skip-reason-badge.tsx`.

---

## 6. Test harness

- `tests/unit/control-plane/skip-reason-copy.test.ts` — toda chave em [BR-DISPATCH-004](../50-business-rules/BR-DISPATCH.md) tem entrada no copy deck.
- Snapshot test do componente para todos os reasons.
- Test de A11y: todo botão de ação tem `aria-label`.

---

## 7. Manutenção

Quando novo `skip_reason` ou `error_code` for adicionado em código (BR-DISPATCH-004 ou dispatcher),
**DEVE** ser adicionado neste copy deck no mesmo PR. Auditor `globaltracker-br-auditor` checa via grep.

## 8. Referências

- [BR-DISPATCH](../50-business-rules/BR-DISPATCH.md) — `skip_reason` canônicos
- [40-integrations/01-meta-capi.md](../40-integrations/01-meta-capi.md) — error codes Meta
- [40-integrations/06-ga4-measurement-protocol.md](../40-integrations/06-ga4-measurement-protocol.md) — error codes GA4
- [60-flows/02-capture-lead-and-attribute.md](../60-flows/02-capture-lead-and-attribute.md) — erros HTTP Edge
