// BR-DISPATCH-004: skip_reason e error_code mapeados para copy PT-BR humanizado
export type SkipReasonCopy = {
  title: string;
  body: string;
  action?: { label: string; href: string };
};

// §1 — skip_reason (BR-DISPATCH-004)
const SKIP_REASON_COPY: Record<string, SkipReasonCopy> = {
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
      href: '/integrations/meta',
    },
  },
  integration_not_configured: {
    title: 'Integração não configurada',
    body: 'Workspace não tem credenciais para esse destino.',
    action: { label: 'Configurar agora', href: '/integrations' },
  },
  no_click_id_available: {
    title: 'Sem identificador de clique',
    body: 'Google Ads precisa de `gclid` (clique vindo de campanha Google) para registrar conversão. Esse lead chegou de outra fonte.',
  },
  audience_not_eligible: {
    title: 'Audiência abaixo do mínimo',
    body: 'Meta/Google exigem mínimo de 1.000 pessoas para sincronizar Custom Audience.',
    action: { label: 'Ver audiência', href: '/audiences' },
  },
  archived_launch: {
    title: 'Lançamento arquivado',
    body: 'Eventos de lançamentos arquivados não são despachados a destinos externos. Permanecem no sistema para análise histórica.',
  },
  no_ga4_equivalent: {
    title: 'Evento sem equivalente GA4',
    body: 'Esse tipo de evento não tem evento recomendado no GA4. Configure mapeamento custom se necessário.',
  },
};

// §2 — error_code por destino (falhas, não skips)

const META_ERROR_COPY: Record<string, SkipReasonCopy> = {
  invalid_pixel_id: {
    title: 'Pixel ID inválido',
    body: 'O Pixel ID configurado não foi reconhecido pelo Meta. Verifique se foi copiado corretamente do Meta Business Manager.',
    action: { label: 'Editar configuração', href: '/integrations/meta' },
  },
  invalid_access_token: {
    title: 'Token CAPI inválido ou expirado',
    body: 'O token de acesso da CAPI não foi aceito. Tokens expiram ou podem ser revogados.',
    action: { label: 'Renovar token', href: '/integrations/meta' },
  },
  domain_not_verified: {
    title: 'Domínio não verificado no Meta',
    body: 'O domínio da landing page não está verificado no Meta Business Manager.',
    action: {
      label: 'Abrir Domain Verification',
      href: 'https://business.facebook.com/settings/owned-domains',
    },
  },
  event_dropped_due_to_acceptance_policy: {
    title: 'Evento descartado pelo Meta',
    body: 'Meta descartou o evento (geralmente por iOS 14+ AEM). Verifique priorização de eventos.',
    action: {
      label: 'Abrir Aggregated Event Measurement',
      href: 'https://business.facebook.com/events_manager2/list',
    },
  },
  rate_limited: {
    title: 'Limite de requests do Meta atingido',
    body: 'O Meta limitou a frequência de envios. Sistema vai retentar automaticamente.',
  },
  unknown_error: {
    title: 'Erro inesperado do Meta',
    body: 'Meta retornou erro não catalogado. Veja detalhes técnicos abaixo.',
  },
};

const GA4_ERROR_COPY: Record<string, SkipReasonCopy> = {
  invalid_measurement_id: {
    title: 'Measurement ID inválido',
    body: 'O Measurement ID configurado não foi reconhecido pelo GA4.',
    action: { label: 'Editar configuração', href: '/integrations/ga4' },
  },
  invalid_api_secret: {
    title: 'API Secret inválido',
    body: 'O API Secret configurado foi rejeitado pelo GA4.',
    action: { label: 'Renovar API Secret', href: '/integrations/ga4' },
  },
  validation_failed: {
    title: 'Payload rejeitado pelo GA4',
    body: 'GA4 rejeitou o evento por validação. Geralmente parâmetros obrigatórios faltando (ex.: `items[]` em e-commerce).',
  },
};

const GOOGLE_ADS_ERROR_COPY: Record<string, SkipReasonCopy> = {
  invalid_conversion_action: {
    title: 'Conversion Action inválido',
    body: 'O Conversion Action configurado não existe na conta Google Ads.',
    action: { label: 'Editar configuração', href: '/integrations/google_ads' },
  },
  gclid_not_found: {
    title: 'Clique não encontrado',
    body: 'O `gclid` não corresponde a nenhum clique conhecido pelo Google. Pode ser muito antigo (>90d).',
  },
  conversion_outside_window: {
    title: 'Conversão fora da janela',
    body: 'A conversão chegou após a janela de atribuição configurada no Google Ads.',
  },
};

// §3 — erros HTTP do Edge
const HTTP_ERROR_COPY: Record<string, SkipReasonCopy> = {
  validation_error: {
    title: 'Dados inválidos no formulário',
    body: 'O sistema rejeitou o envio por dados malformados. Verifique tipos e campos obrigatórios.',
  },
  missing_identifier: {
    title: 'Lead sem email nem telefone',
    body: 'Não foi possível identificar o lead — pelo menos um de email ou telefone é obrigatório.',
  },
  bot_detected: {
    title: 'Tentativa bloqueada (bot)',
    body: 'Sistema anti-bot detectou padrão suspeito no envio (honeypot ou tempo). Provavelmente automatizado.',
  },
  invalid_token: {
    title: 'Token da página inválido',
    body: 'O token configurado no snippet não é mais válido (revogado ou expirado).',
  },
  origin_not_allowed: {
    title: 'Domínio não autorizado',
    body: 'Tentativa de tracking veio de domínio fora da lista permitida desta página.',
  },
  page_not_found: {
    title: 'Página não encontrada',
    body: 'O `page_public_id` no snippet não corresponde a nenhuma página deste workspace.',
  },
  // archived_launch também aparece como HTTP error; mesma copy do skip_reason
  rate_limited: {
    title: 'Limite de envios atingido',
    body: 'Você atingiu o limite de eventos por minuto deste workspace. Reduza frequência ou solicite aumento.',
  },
};

const FALLBACK_COPY: SkipReasonCopy = {
  title: 'Evento não enviado',
  body: 'Não foi possível processar o envio. Verifique os detalhes abaixo.',
};

export function getSkipCopy(reason: string): SkipReasonCopy {
  return SKIP_REASON_COPY[reason] ?? FALLBACK_COPY;
}

export function getErrorCopy(
  destination: string,
  errorCode: string,
): SkipReasonCopy {
  const map: Record<string, Record<string, SkipReasonCopy>> = {
    meta: META_ERROR_COPY,
    ga4: GA4_ERROR_COPY,
    google_ads: GOOGLE_ADS_ERROR_COPY,
    google_ads_enhanced: GOOGLE_ADS_ERROR_COPY,
  };
  return map[destination]?.[errorCode] ?? FALLBACK_COPY;
}

export function getHttpErrorCopy(
  _status: number,
  errorCode: string,
): SkipReasonCopy {
  return HTTP_ERROR_COPY[errorCode] ?? FALLBACK_COPY;
}

export { SKIP_REASON_COPY };
