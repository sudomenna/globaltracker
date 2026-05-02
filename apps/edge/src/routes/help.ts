/**
 * routes/help.ts — GET /v1/help/skip-reason/:reason
 *
 * Rota pública de ajuda contextual. Retorna título, corpo e ação sugerida
 * em PT-BR para um determinado código de skip_reason, error_code ou erro HTTP.
 *
 * CONTRACT-api-help-skip-reason-v1
 *
 * ORCHESTRATOR MOUNT (adicionar em apps/edge/src/index.ts após as outras rotas):
 * import { helpRoute } from './routes/help.js';
 * app.route('/v1/help', helpRoute);
 *
 * Auth: NENHUMA — rota pública. Conteúdo de ajuda não contém PII.
 *
 * Lookup: mapa estático em memória. Zero DB, zero Hyperdrive.
 * Cobre:
 *   §1 — skip_reasons (BR-DISPATCH-004)
 *   §2 — error_codes por destino (prefixados com `meta:`, `ga4:`, `google_ads:`)
 *   §3 — erros HTTP do Edge (prefixados com `http_${status}_${error_code}`)
 *
 * Cache: Cache-Control: max-age=3600 (conteúdo estático, 1h).
 *
 * BR-PRIVACY-001: zero PII em conteúdo, logs e respostas de erro.
 *   O `reason` em si não é PII — é código técnico de catálogo.
 */

import { Hono } from 'hono';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bindings mínimos — sem DB nem KV necessário para essa rota
// ---------------------------------------------------------------------------

type AppBindings = {
  ENVIRONMENT: string;
};

type AppVariables = {
  request_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type HelpResponse = {
  reason: string;
  title: string;
  body: string;
  action?: {
    label: string;
    href: string;
  };
};

// ---------------------------------------------------------------------------
// Path param schema
// ---------------------------------------------------------------------------

const ReasonParamSchema = z.object({
  reason: z.string().min(1).max(128),
});

// ---------------------------------------------------------------------------
// Help catalog — mapa estático
//
// Fontes:
//   §1: docs/70-ux/11-copy-deck-skip-messages.md §1 (skip_reasons)
//   §2: docs/70-ux/11-copy-deck-skip-messages.md §2 (error_codes por destino)
//   §3: docs/70-ux/11-copy-deck-skip-messages.md §3 (erros HTTP)
//
// Prefixação das chaves §2:
//   Meta CAPI   → `meta:<error_code>`
//   GA4 MP      → `ga4:<error_code>`
//   Google Ads  → `google_ads:<error_code>`
//
// Prefixação das chaves §3:
//   `http_${status}_${error_code}`  (ex.: `http_401_invalid_token`)
// ---------------------------------------------------------------------------

// Omit `reason` from the stored value — it's filled dynamically at lookup time.
type HelpEntry = Omit<HelpResponse, 'reason'>;

const HELP_CATALOG: Record<string, HelpEntry> = {
  // -------------------------------------------------------------------------
  // §1 — Skip reasons (BR-DISPATCH-004)
  // -------------------------------------------------------------------------

  'consent_denied:ad_user_data': {
    title: 'Lead negou anúncios',
    body: 'O lead não autorizou uso de dados para anúncios. Eventos de conversão para Meta/Google Ads ficam bloqueados. Analytics segue normalmente.',
  },

  'consent_denied:ad_personalization': {
    title: 'Lead negou personalização',
    body: 'O lead permite anúncios mas não personalização. Custom Audiences ficam bloqueadas.',
  },

  'consent_denied:analytics': {
    title: 'Lead negou analytics',
    body: 'O lead não autorizou rastreamento analítico. GA4 fica bloqueado.',
  },

  'consent_denied:functional': {
    title: 'Lead negou cookies funcionais',
    body: 'Cookies próprios (`__ftk`) não foram setados. Replay de identidade pode falhar.',
  },

  no_user_data: {
    title: 'Sem identificador do lead',
    body: 'Meta exige pelo menos um destes: email, telefone, fbc, fbp, external_id. Nenhum estava disponível.',
    action: {
      label: 'Verificar captura no formulário',
      href: '/launches',
    },
  },

  integration_not_configured: {
    title: 'Integração não configurada',
    body: 'Workspace não tem credenciais para esse destino.',
    action: {
      label: 'Configurar agora',
      href: '/integrations',
    },
  },

  no_click_id_available: {
    title: 'Sem identificador de clique',
    body: 'Google Ads precisa de `gclid` (clique vindo de campanha Google) para registrar conversão. Esse lead chegou de outra fonte.',
  },

  audience_not_eligible: {
    title: 'Audiência abaixo do mínimo',
    body: 'Meta/Google exigem mínimo de 1.000 pessoas para sincronizar Custom Audience.',
    action: {
      label: 'Ver audiência',
      href: '/audiences',
    },
  },

  archived_launch: {
    title: 'Lançamento arquivado',
    body: 'Eventos de lançamentos arquivados não são despachados a destinos externos. Permanecem no sistema para análise histórica.',
  },

  no_ga4_equivalent: {
    title: 'Evento sem equivalente GA4',
    body: 'Esse tipo de evento (ex.: `Subscribe`) não tem evento recomendado no GA4. Configure mapeamento custom se necessário.',
    action: {
      label: 'Configurar mapeamento',
      href: '/integrations/ga4',
    },
  },

  // -------------------------------------------------------------------------
  // §2 — Failed events — Meta CAPI
  // Prefixo: `meta:`
  // -------------------------------------------------------------------------

  'meta:invalid_pixel_id': {
    title: 'Pixel ID inválido',
    body: 'O Pixel ID configurado não foi reconhecido pelo Meta. Verifique se foi copiado corretamente do Meta Business Manager.',
    action: {
      label: 'Editar configuração',
      href: '/integrations/meta',
    },
  },

  'meta:invalid_access_token': {
    title: 'Token CAPI inválido ou expirado',
    body: 'O token de acesso da CAPI não foi aceito. Tokens expiram ou podem ser revogados.',
    action: {
      label: 'Renovar token',
      href: '/integrations/meta',
    },
  },

  'meta:domain_not_verified': {
    title: 'Domínio não verificado no Meta',
    body: 'O domínio da landing page não está verificado no Meta Business Manager.',
    action: {
      label: 'Abrir Domain Verification',
      href: 'https://business.facebook.com/settings/owned-domains',
    },
  },

  'meta:event_dropped_due_to_acceptance_policy': {
    title: 'Evento descartado pelo Meta',
    body: 'Meta descartou o evento (geralmente por iOS 14+ AEM). Verifique priorização de eventos.',
    action: {
      label: 'Abrir Aggregated Event Measurement',
      href: 'https://business.facebook.com/events_manager/aggregated-events',
    },
  },

  'meta:rate_limited': {
    title: 'Limite de requests do Meta atingido',
    body: 'O Meta limitou a frequência de envios. Sistema vai retentar automaticamente.',
  },

  'meta:unknown_error': {
    title: 'Erro inesperado do Meta',
    body: 'Meta retornou erro não catalogado. Veja detalhes técnicos abaixo.',
    action: {
      label: 'Ver payload',
      href: '/integrations/meta',
    },
  },

  // -------------------------------------------------------------------------
  // §2 — Failed events — GA4 Measurement Protocol
  // Prefixo: `ga4:`
  // -------------------------------------------------------------------------

  'ga4:invalid_measurement_id': {
    title: 'Measurement ID inválido',
    body: 'O Measurement ID configurado não foi reconhecido pelo GA4.',
    action: {
      label: 'Editar configuração',
      href: '/integrations/ga4',
    },
  },

  'ga4:invalid_api_secret': {
    title: 'API Secret inválido',
    body: 'O API Secret configurado foi rejeitado pelo GA4.',
    action: {
      label: 'Renovar API Secret',
      href: '/integrations/ga4',
    },
  },

  'ga4:validation_failed': {
    title: 'Payload rejeitado pelo GA4',
    body: 'GA4 rejeitou o evento por validação. Geralmente parâmetros obrigatórios faltando (ex.: `items[]` em e-commerce).',
    action: {
      label: 'Ver payload',
      href: '/integrations/ga4',
    },
  },

  // -------------------------------------------------------------------------
  // §2 — Failed events — Google Ads Conversion Upload
  // Prefixo: `google_ads:`
  // -------------------------------------------------------------------------

  'google_ads:invalid_conversion_action': {
    title: 'Conversion Action inválido',
    body: 'O Conversion Action configurado não existe na conta Google Ads.',
    action: {
      label: 'Editar configuração',
      href: '/integrations/google_ads',
    },
  },

  'google_ads:gclid_not_found': {
    title: 'Clique não encontrado',
    body: 'O `gclid` não corresponde a nenhum clique conhecido pelo Google. Pode ser muito antigo (>90d).',
  },

  'google_ads:conversion_outside_window': {
    title: 'Conversão fora da janela',
    body: 'A conversão chegou após a janela de atribuição configurada no Google Ads.',
    action: {
      label: 'Ver configuração de janela',
      href: '/integrations/google_ads',
    },
  },

  // -------------------------------------------------------------------------
  // §3 — Erros HTTP do Edge
  // Prefixo: `http_${status}_${error_code}`
  // -------------------------------------------------------------------------

  http_400_validation_error: {
    title: 'Dados inválidos no formulário',
    body: 'O sistema rejeitou o envio por dados malformados. Verifique tipos e campos obrigatórios.',
    action: {
      label: 'Ver payload',
      href: '/integrations',
    },
  },

  http_400_missing_identifier: {
    title: 'Lead sem email nem telefone',
    body: 'Não foi possível identificar o lead — pelo menos um de email ou telefone é obrigatório.',
    action: {
      label: 'Verificar formulário',
      href: '/launches',
    },
  },

  http_400_bot_detected: {
    title: 'Tentativa bloqueada (bot)',
    body: 'Sistema anti-bot detectou padrão suspeito no envio (honeypot ou tempo). Provavelmente automatizado.',
  },

  http_401_invalid_token: {
    title: 'Token da página inválido',
    body: 'O token configurado no snippet não é mais válido (revogado ou expirado).',
    action: {
      label: 'Rotacionar token',
      href: '/launches',
    },
  },

  http_403_origin_not_allowed: {
    title: 'Domínio não autorizado',
    body: 'Tentativa de tracking veio de domínio fora da lista permitida desta página.',
    action: {
      label: 'Adicionar domínio',
      href: '/launches',
    },
  },

  http_404_page_not_found: {
    title: 'Página não encontrada',
    body: 'O `page_public_id` no snippet não corresponde a nenhuma página deste workspace.',
    action: {
      label: 'Verificar snippet',
      href: '/launches',
    },
  },

  http_410_archived_launch: {
    title: 'Lançamento arquivado',
    body: 'O lançamento desta página foi arquivado e não aceita mais eventos.',
    action: {
      label: 'Ver lançamento',
      href: '/launches',
    },
  },

  http_429_rate_limited: {
    title: 'Limite de envios atingido',
    body: 'Você atingiu o limite de eventos por minuto deste workspace. Reduza frequência ou solicite aumento.',
    action: {
      label: 'Ver quota',
      href: '/integrations',
    },
  },
};

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the help sub-router.
 *
 * Usage in index.ts (wired by orchestrator):
 * ```ts
 * import { helpRoute } from './routes/help.js';
 * app.route('/v1/help', helpRoute);
 * ```
 */
export function createHelpRoute(): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // GET /skip-reason/:reason
  // CONTRACT-api-help-skip-reason-v1
  //
  // Rota pública — conteúdo de ajuda não contém PII.
  // BR-PRIVACY-001: zero PII em conteúdo, logs e respostas de erro.
  // -------------------------------------------------------------------------
  route.get('/skip-reason/:reason', (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // Validate :reason path param
    // -----------------------------------------------------------------------
    const parseResult = ReasonParamSchema.safeParse({
      reason: c.req.param('reason'),
    });

    if (!parseResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'reason param is invalid',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const reason = parseResult.data.reason;

    // -----------------------------------------------------------------------
    // Lookup in static catalog
    // -----------------------------------------------------------------------
    const entry = HELP_CATALOG[reason];

    if (!entry) {
      return c.json(
        {
          code: 'reason_not_found',
          message: 'Reason not in help catalog',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 200 — return help content with cache header
    // Cache-Control: max-age=3600 — conteúdo estático, pode ser cacheado 1h
    // -----------------------------------------------------------------------
    const response: HelpResponse = { reason, ...entry };

    return c.json(response, 200, {
      'X-Request-Id': requestId,
      'Cache-Control': 'max-age=3600',
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance for direct mounting.
// ---------------------------------------------------------------------------

/**
 * Default helpRoute instance.
 *
 * Wire in index.ts via:
 * ```ts
 * app.route('/v1/help', helpRoute);
 * ```
 */
export const helpRoute = createHelpRoute();
