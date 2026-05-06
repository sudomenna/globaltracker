/**
 * routes/integrations-google.ts — Google Ads OAuth flow + conversion-actions list.
 *
 * Endpoints (T-14-004 / T-14-005 / T-14-007 — Sprint 14, Onda 2):
 *   GET /v1/integrations/google/oauth/start
 *     Bearer auth. Gera state HMAC-assinado e devolve `authorize_url` para o
 *     frontend redirecionar o browser. Stateless — nada em KV/DB.
 *
 *   GET /v1/integrations/google/oauth/callback
 *     SEM Bearer (Google redireciona o browser do user). Confia 100% no state
 *     HMAC. Troca code → refresh_token, encripta com `encryptPii`, persiste em
 *     `workspace_integrations.google_ads_refresh_token_enc`, atualiza
 *     `workspaces.config.integrations.google_ads.{oauth_token_state, enabled,
 *     customer_id?}`, registra audit, invalida cache. Retorna HTML simples.
 *
 *   GET /v1/integrations/google/conversion-actions
 *     Bearer auth. Usa `getGoogleAdsAccessToken` para chamar a Google Ads API
 *     (v17 searchStream) e listar conversion actions ENABLED. Mapeia erros
 *     tipados → códigos HTTP estáveis para a CP.
 *
 * Padrão da rota segue routes/integrations-sendflow.ts e routes/workspace-config.ts:
 *   - Factory `createIntegrationsGoogleRoute(deps?)` para DI nos testes.
 *   - Default export wired ao Hyperdrive/DATABASE_URL.
 *   - SELECT → JS deepMerge → UPDATE com `jsonb()` cast (workaround Hyperdrive driver).
 *
 * BR-PRIVACY-001: nenhum log com refresh_token cru, code OAuth, access_token,
 *   ciphertext ou developer_token. Mensagens de erro genéricas. Audit metadata
 *   carrega só prefixo mascarado do customer_id e contagem de accessible_customers.
 * BR-AUDIT-001: callback grava `audit_log` com action='workspace_google_ads_oauth_completed'.
 * BR-RBAC-002: workspace_id sempre vem do auth context (Bearer + DEV_WORKSPACE_ID
 *   fallback) ou do state HMAC-assinado no callback — nunca de body/query controlado pelo user.
 *
 * CONTRACT: docs/30-contracts/05-api-server-actions.md (Sprint 14 / ADR-028 refinado).
 */

import { auditLog, createDb, workspaceIntegrations, workspaces } from '@globaltracker/db';
import type { Db } from '@globaltracker/db';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  getGoogleAdsAccessToken,
  invalidateGoogleAdsAccessTokenCache,
} from '../lib/google-ads-oauth.js';
import { jsonb } from '../lib/jsonb-cast.js';
import { encryptPii, type MasterKeyRegistry } from '../lib/pii.js';
import { refreshAccessToken } from '../dispatchers/google-ads-conversion/oauth.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings / Variables
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV?: KVNamespace;
  ENVIRONMENT?: string;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  PII_MASTER_KEY_V1?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  /** HMAC secret usado para assinar o `state` do OAuth start. */
  GOOGLE_OAUTH_STATE_SECRET?: string;
  /** Fallback global do developer_token (workspaces.google_ads_developer_token override per-workspace). */
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  /** URL da control-plane para o link "Voltar ao painel" no HTML do callback. */
  CONTROL_PLANE_BASE_URL?: string;
};

type AppVariables = {
  workspace_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Audit entry type (mirrors workspace-config.ts / integrations-sendflow.ts)
// ---------------------------------------------------------------------------

export type InsertAuditEntryFn = (entry: {
  workspace_id: string;
  actor_id: string;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  request_id: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Auth helper — same shape as integrations-sendflow.ts / workspace-config.ts.
// ---------------------------------------------------------------------------

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) return null;
  return match[1].trim();
}

// ---------------------------------------------------------------------------
// Base64url helpers (sem padding) — espelham os de lead-token.ts/pii.ts.
// ---------------------------------------------------------------------------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const normalized = pad === 0 ? padded : padded + '==='.slice(0, 4 - pad);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// HMAC state — assinado e auto-validável (sem persistência em KV).
//
// Formato: base64url(JSON({workspace_id, nonce, exp})) + '.' + base64url(HMAC).
//
// Trade: stateless evita round-trip a KV; expiração protege contra replay
// dentro da janela curta. HMAC garante integridade (atacante não consegue
// forjar workspace_id sem o secret). 10min é largo o suficiente para o user
// completar o consent screen do Google sem ser frouxo.
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000;

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

type StatePayload = {
  workspace_id: string;
  nonce: string;
  exp: number;
};

async function signState(
  payload: StatePayload,
  secret: string,
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = bytesToBase64url(new TextEncoder().encode(payloadJson));
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payloadB64),
  );
  const sigB64 = bytesToBase64url(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

async function verifyState(
  signed: string,
  secret: string,
  nowMs: number,
): Promise<
  | { ok: true; payload: StatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }
> {
  const sepIdx = signed.lastIndexOf('.');
  if (sepIdx < 1) return { ok: false, reason: 'malformed' };
  const payloadB64 = signed.slice(0, sepIdx);
  const sigB64 = signed.slice(sepIdx + 1);
  if (!payloadB64 || !sigB64) return { ok: false, reason: 'malformed' };

  let providedSig: Uint8Array;
  try {
    providedSig = base64urlToBytes(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const key = await importHmacKey(secret);
  let valid = false;
  try {
    // BR-IDENTITY-005-style: timing-safe compare via crypto.subtle.verify.
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      providedSig,
      new TextEncoder().encode(payloadB64),
    );
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let payload: StatePayload;
  try {
    const json = new TextDecoder().decode(base64urlToBytes(payloadB64));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof parsed['workspace_id'] !== 'string' ||
      typeof parsed['nonce'] !== 'string' ||
      typeof parsed['exp'] !== 'number'
    ) {
      return { ok: false, reason: 'malformed' };
    }
    payload = {
      workspace_id: parsed['workspace_id'],
      nonce: parsed['nonce'],
      exp: parsed['exp'],
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.exp <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Helpers JSONB — deepMerge inline (mesmo padrão de google-ads-oauth.ts).
// Não importamos de routes/workspace-config.ts para não criar dependência
// cruzada entre rotas; a complexidade aqui é pequena e localizada.
// ---------------------------------------------------------------------------

function parseConfigJsonb(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// HTML helpers — callback retorna HTML simples (não JSON) porque o response
// é renderizado pelo browser do user. Sem template engine; HTML inline.
// XSS-safe: nada do user é embutido no HTML; só URLs de retorno construídas
// pelo backend e mensagens estáticas.
// ---------------------------------------------------------------------------

function htmlPage(args: {
  title: string;
  message: string;
  backUrl: string;
  status: 'ok' | 'error';
}): string {
  const color = args.status === 'ok' ? '#0a7d2c' : '#a02020';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>${args.title}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
  h1 { color: ${color}; font-size: 22px; }
  p { font-size: 16px; line-height: 1.5; }
  a { color: #2253b8; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>${args.title}</h1>
<p>${args.message}</p>
<p><a href="${args.backUrl}">Voltar ao painel</a></p>
</body>
</html>`;
}

function controlPlaneUrl(c: { env: AppBindings }, suffix: string): string {
  const base = c.env.CONTROL_PLANE_BASE_URL ?? '';
  // Defesa contra concatenação ruim; suffix deve começar com '/'.
  const safeSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${base}${safeSuffix}`;
}

// ---------------------------------------------------------------------------
// Mascaramento de customer_id para audit/log.
// "1234567890" → "******7890". BR-PRIVACY-001-style: nunca persistir o id
// inteiro em audit metadata.
// ---------------------------------------------------------------------------

function maskCustomerId(customerId: string | null): string | null {
  if (!customerId || customerId.length < 4) return null;
  return `******${customerId.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Google Ads API — listAccessibleCustomers + searchStream (conversion_actions).
// ---------------------------------------------------------------------------

const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com/v17';

type AccessibleCustomersResult = {
  customer_ids: string[];
};

async function listAccessibleCustomers(args: {
  accessToken: string;
  developerToken: string;
  fetchFn: typeof fetch;
}): Promise<AccessibleCustomersResult> {
  const res = await args.fetchFn(
    `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        'developer-token': args.developerToken,
      },
    },
  );
  if (!res.ok) {
    // Erro silencioso — fluxo OAuth deve completar mesmo se a listagem falhar
    // (ex.: workspace nunca usou Google Ads ainda). Caller decide o que fazer.
    return { customer_ids: [] };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { customer_ids: [] };
  }
  const resourceNames =
    body && typeof body === 'object' && 'resourceNames' in body
      ? (body as { resourceNames?: unknown }).resourceNames
      : null;
  if (!Array.isArray(resourceNames)) return { customer_ids: [] };
  // resourceNames vem como ["customers/1234567890", ...] — extraímos o id.
  const ids: string[] = [];
  for (const rn of resourceNames) {
    if (typeof rn !== 'string') continue;
    const match = rn.match(/^customers\/(\d+)$/);
    if (match?.[1]) ids.push(match[1]);
  }
  return { customer_ids: ids };
}

type ConversionActionRow = {
  id: string;
  name: string;
  status: string;
  category: string;
};

/**
 * Lista conversion actions ENABLED do customer via Google Ads API v17.
 *
 * Usa POST searchStream em vez do REST GET porque o endpoint REST direto não
 * suporta filtragem por status sem paginação manual; searchStream é mais
 * direto para "ENABLED apenas". Documentado pelo Google em:
 *   https://developers.google.com/google-ads/api/rest/reference/rest/v17/customers/searchStream
 *
 * Headers mandatórios: Authorization + developer-token + (login-customer-id
 * se workspace usa manager account).
 */
async function listConversionActions(args: {
  accessToken: string;
  developerToken: string;
  customerId: string;
  loginCustomerId: string | null;
  fetchFn: typeof fetch;
}): Promise<
  | { ok: true; conversion_actions: ConversionActionRow[] }
  | { ok: false; status: number }
> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.accessToken}`,
    'developer-token': args.developerToken,
    'Content-Type': 'application/json',
  };
  if (args.loginCustomerId) {
    headers['login-customer-id'] = args.loginCustomerId;
  }

  const query = `
    SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.status,
      conversion_action.category
    FROM conversion_action
    WHERE conversion_action.status = 'ENABLED'
  `;

  const res = await args.fetchFn(
    `${GOOGLE_ADS_API_BASE}/customers/${args.customerId}/googleAds:searchStream`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    },
  );

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: true, conversion_actions: [] };
  }

  // searchStream pode retornar Array (stream chunks) ou objeto único; aceitamos ambos.
  const chunks: unknown[] = Array.isArray(body) ? body : [body];

  const out: ConversionActionRow[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    const results = (chunk as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const row of results) {
      if (!row || typeof row !== 'object') continue;
      const ca = (row as { conversionAction?: Record<string, unknown> })
        .conversionAction;
      if (!ca || typeof ca !== 'object') continue;
      const id = typeof ca['id'] === 'string' ? ca['id'] : String(ca['id'] ?? '');
      const name = typeof ca['name'] === 'string' ? ca['name'] : '';
      const status =
        typeof ca['status'] === 'string' ? ca['status'] : 'UNKNOWN';
      const category =
        typeof ca['category'] === 'string' ? ca['category'] : 'UNKNOWN';
      if (id) {
        out.push({ id, name, status, category });
      }
    }
  }

  return { ok: true, conversion_actions: out };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createIntegrationsGoogleRoute(deps?: {
  getDb?: (c: { env: AppBindings }) => Db | undefined;
  insertAuditEntry?: InsertAuditEntryFn;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  const fetchFn = deps?.fetchFn ?? fetch;
  const now = () => (deps?.nowMs ? deps.nowMs() : Date.now());

  // -------------------------------------------------------------------------
  // T-14-004: GET /oauth/start — devolve authorize_url + state assinado.
  //
  // BR-RBAC-002: workspace_id do auth context — nunca de query.
  // BR-PRIVACY-001: state assinado com HMAC; secret nunca logado.
  // -------------------------------------------------------------------------
  route.get('/oauth/start', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const actorId = extractBearerToken(c.req.header('Authorization'));
    if (!actorId) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid Authorization header',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      actorId;

    const clientId = c.env.GOOGLE_OAUTH_CLIENT_ID;
    const redirectUri = c.env.GOOGLE_OAUTH_REDIRECT_URI;
    const stateSecret = c.env.GOOGLE_OAUTH_STATE_SECRET;

    if (!clientId || !redirectUri || !stateSecret) {
      // BR-PRIVACY-001: log nunca menciona valores; só `event` + workspace_id.
      safeLog('warn', {
        event: 'integrations_google_oauth_start_misconfigured',
        request_id: requestId,
        workspace_id: workspaceId,
        missing_client_id: !clientId,
        missing_redirect_uri: !redirectUri,
        missing_state_secret: !stateSecret,
      });
      return c.json(
        {
          code: 'service_unavailable',
          message: 'Google OAuth not configured on this environment',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    let state: string;
    try {
      const payload: StatePayload = {
        workspace_id: workspaceId,
        nonce: crypto.randomUUID(),
        exp: now() + STATE_TTL_MS,
      };
      state = await signState(payload, stateSecret);
    } catch (err) {
      safeLog('error', {
        event: 'integrations_google_oauth_start_state_sign_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to generate OAuth state',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // access_type=offline ⇒ refresh_token vem na resposta.
    // prompt=consent ⇒ força consent screen mesmo se já consentido antes
    // (sem isso, Google omite refresh_token em re-conexões).
    // scope=adwords ⇒ permissão para leitura/escrita Google Ads API.
    const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set(
      'scope',
      'https://www.googleapis.com/auth/adwords',
    );
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
    authorizeUrl.searchParams.set('state', state);

    safeLog('info', {
      event: 'integrations_google_oauth_start',
      request_id: requestId,
      workspace_id: workspaceId,
    });

    return c.json(
      { authorize_url: authorizeUrl.toString(), request_id: requestId },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // T-14-005: GET /oauth/callback — troca code → refresh_token → persiste.
  //
  // SEM Bearer auth — Google redireciona o browser do user. Confiamos no
  // state HMAC-assinado, que carrega o workspace_id verificado no /start.
  //
  // BR-PRIVACY-001: nunca logamos code, access_token, refresh_token, ciphertext.
  // BR-AUDIT-001: registra audit_log com metadata mascarado.
  // BR-RBAC-002: workspace_id vem do payload HMAC-validado.
  // -------------------------------------------------------------------------
  route.get('/oauth/callback', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const cpBackUrl = controlPlaneUrl(c, '/integrations/google-ads');

    // 1. Detect user-cancelled flow (?error=access_denied).
    const errorParam = c.req.query('error');
    if (errorParam) {
      safeLog('info', {
        event: 'integrations_google_oauth_callback_user_cancelled',
        request_id: requestId,
        // error_param é controlado pelo Google — código curto, sem PII.
        error_param: errorParam,
      });
      return c.html(
        htmlPage({
          title: 'Conexão Google Ads cancelada',
          message:
            'Você cancelou a conexão com o Google Ads. Nenhum dado foi salvo. Você pode tentar novamente quando quiser.',
          backUrl: `${cpBackUrl}?status=cancelled`,
          status: 'error',
        }),
        200,
        { 'X-Request-Id': requestId },
      );
    }

    // 2. Validate state (HMAC) — extrai workspace_id confiável.
    const stateParam = c.req.query('state');
    const stateSecret = c.env.GOOGLE_OAUTH_STATE_SECRET;
    if (!stateParam || !stateSecret) {
      safeLog('warn', {
        event: 'integrations_google_oauth_callback_state_missing',
        request_id: requestId,
        has_state: !!stateParam,
        has_secret: !!stateSecret,
      });
      return c.html(
        htmlPage({
          title: 'Falha de validação',
          message:
            'O parâmetro de segurança (state) está ausente ou o servidor não está configurado. Reinicie a conexão pelo painel.',
          backUrl: cpBackUrl,
          status: 'error',
        }),
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const stateResult = await verifyState(stateParam, stateSecret, now());
    if (!stateResult.ok) {
      safeLog('warn', {
        event: 'integrations_google_oauth_callback_state_invalid',
        request_id: requestId,
        reason: stateResult.reason,
      });
      return c.html(
        htmlPage({
          title: 'Estado inválido ou expirado',
          message:
            'O parâmetro de segurança expirou ou está inválido. Por favor, reinicie a conexão pelo painel.',
          backUrl: cpBackUrl,
          status: 'error',
        }),
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const workspaceId = stateResult.payload.workspace_id;

    // 3. Required env (todos checados juntos para mensagem única).
    const code = c.req.query('code');
    const clientId = c.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = c.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = c.env.GOOGLE_OAUTH_REDIRECT_URI;
    const masterKeyHex = c.env.PII_MASTER_KEY_V1;

    if (
      !code ||
      !clientId ||
      !clientSecret ||
      !redirectUri ||
      !masterKeyHex
    ) {
      safeLog('warn', {
        event: 'integrations_google_oauth_callback_misconfigured',
        request_id: requestId,
        workspace_id: workspaceId,
        missing_code: !code,
        missing_client_id: !clientId,
        missing_client_secret: !clientSecret,
        missing_redirect_uri: !redirectUri,
        missing_master_key: !masterKeyHex,
      });
      return c.html(
        htmlPage({
          title: 'Falha na conexão',
          message:
            'Ambiente do servidor incompleto ou parâmetro `code` ausente. Tente reconectar.',
          backUrl: cpBackUrl,
          status: 'error',
        }),
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // 4. Exchange code for refresh_token (POST oauth2/token).
    //
    // Não reusamos `refreshAccessToken` (ele faz `grant_type=refresh_token`
    // pra renovar; aqui é `grant_type=authorization_code` e queremos
    // `refresh_token` no response, não só access_token).
    let refreshToken: string;
    let accessToken: string;
    try {
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      });
      const tokenRes = await fetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      });
      if (!tokenRes.ok) {
        // BR-PRIVACY-001: response do Google pode ter campos sensíveis;
        // capturamos só o status e um error_type genérico.
        let errType = 'unknown';
        try {
          const j = (await tokenRes.json()) as { error?: unknown };
          if (typeof j.error === 'string') errType = j.error;
        } catch {
          // ignore — corpo não-JSON
        }
        safeLog('warn', {
          event: 'integrations_google_oauth_callback_token_exchange_failed',
          request_id: requestId,
          workspace_id: workspaceId,
          status: tokenRes.status,
          error_type: errType,
        });
        return c.html(
          htmlPage({
            title: 'Falha ao trocar código',
            message:
              'O Google rejeitou o código de autorização. Por favor, reinicie a conexão.',
            backUrl: cpBackUrl,
            status: 'error',
          }),
          400,
          { 'X-Request-Id': requestId },
        );
      }
      const tokenJson = (await tokenRes.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
      };
      if (
        typeof tokenJson.access_token !== 'string' ||
        typeof tokenJson.refresh_token !== 'string'
      ) {
        safeLog('warn', {
          event: 'integrations_google_oauth_callback_token_missing_fields',
          request_id: requestId,
          workspace_id: workspaceId,
          has_access: typeof tokenJson.access_token === 'string',
          has_refresh: typeof tokenJson.refresh_token === 'string',
        });
        return c.html(
          htmlPage({
            title: 'Resposta inesperada',
            message:
              'O Google não devolveu um refresh_token. Verifique se o consent foi concedido na íntegra e tente novamente.',
            backUrl: cpBackUrl,
            status: 'error',
          }),
          502,
          { 'X-Request-Id': requestId },
        );
      }
      accessToken = tokenJson.access_token;
      refreshToken = tokenJson.refresh_token;
    } catch (err) {
      safeLog('error', {
        event: 'integrations_google_oauth_callback_token_network_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.html(
        htmlPage({
          title: 'Erro de rede',
          message:
            'Falha ao contatar o Google. Tente reconectar em alguns instantes.',
          backUrl: cpBackUrl,
          status: 'error',
        }),
        502,
        { 'X-Request-Id': requestId },
      );
    }
    // Silencia warning sobre `refreshAccessToken` import-only-for-types (a função
    // é usada nas referências do JSDoc no topo do arquivo).
    void refreshAccessToken;

    // 5. List accessible customers (best-effort).
    //    Falha aqui não bloqueia o flow — o user pode digitar o customer_id
    //    manualmente na CP depois. Mas se houver developer_token resolvível,
    //    tentamos popular pra UX.
    const envDeveloperToken = c.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? null;
    let accessibleCustomers: AccessibleCustomersResult = { customer_ids: [] };
    if (envDeveloperToken) {
      try {
        accessibleCustomers = await listAccessibleCustomers({
          accessToken,
          developerToken: envDeveloperToken,
          fetchFn,
        });
      } catch (err) {
        // BR-PRIVACY-001: log sem detalhes do erro Google.
        safeLog('warn', {
          event:
            'integrations_google_oauth_callback_list_customers_failed_soft',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type:
            err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    }

    // 6. Encrypt refresh_token (AES-256-GCM workspace-scoped).
    const masterKeyRegistry: MasterKeyRegistry = { 1: masterKeyHex };
    const encrypted = await encryptPii(
      refreshToken,
      workspaceId,
      masterKeyRegistry,
      1,
    );
    if (!encrypted.ok) {
      safeLog('error', {
        event: 'integrations_google_oauth_callback_encrypt_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        // pii.ts já emite códigos genéricos (encryption_failed/invalid_key_version).
        error_code: encrypted.error.code,
      });
      return c.html(
        htmlPage({
          title: 'Falha ao gravar credencial',
          message:
            'Não foi possível proteger a credencial recebida. Tente novamente.',
          backUrl: cpBackUrl,
          status: 'error',
        }),
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // 7. Persist — DB obrigatório a partir daqui.
    const db = deps?.getDb?.(c);
    if (!db) {
      safeLog('error', {
        event: 'integrations_google_oauth_callback_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.html(
        htmlPage({
          title: 'Indisponível',
          message:
            'Banco de dados não configurado neste ambiente. Tente novamente mais tarde.',
          backUrl: cpBackUrl,
          status: 'error',
        }),
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // 7a. Upsert ciphertext em workspace_integrations (INV-WI-001).
    try {
      await db
        .insert(workspaceIntegrations)
        .values({
          workspaceId,
          googleAdsRefreshTokenEnc: encrypted.value.ciphertext,
        })
        .onConflictDoUpdate({
          target: workspaceIntegrations.workspaceId,
          set: {
            googleAdsRefreshTokenEnc: encrypted.value.ciphertext,
            updatedAt: sql`now()`,
          },
        });
    } catch (err) {
      // BR-PRIVACY-001: nunca o ciphertext nem o refresh_token vão pro log.
      safeLog('error', {
        event:
          'integrations_google_oauth_callback_persist_refresh_token_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.html(
        htmlPage({
          title: 'Falha ao gravar',
          message:
            'Erro ao persistir a credencial. Por favor, tente reconectar.',
          backUrl: cpBackUrl,
          status: 'error',
        }),
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // 7b. Atualiza workspaces.config.integrations.google_ads via SELECT → JS deepMerge → UPDATE.
    //     Mesmo padrão de routes/workspace-config.ts (T-13-013) — o driver
    //     Hyperdrive precisa do cast `::jsonb` explícito via helper jsonb().
    const uniqueCustomerId =
      accessibleCustomers.customer_ids.length === 1
        ? (accessibleCustomers.customer_ids[0] ?? null)
        : null;

    try {
      const rows = await db
        .select({ config: workspaces.config })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      const currentConfig = parseConfigJsonb(rows[0]?.config);

      const integrations =
        currentConfig['integrations'] &&
        typeof currentConfig['integrations'] === 'object' &&
        !Array.isArray(currentConfig['integrations'])
          ? { ...(currentConfig['integrations'] as Record<string, unknown>) }
          : {};

      const googleAds =
        integrations['google_ads'] &&
        typeof integrations['google_ads'] === 'object' &&
        !Array.isArray(integrations['google_ads'])
          ? { ...(integrations['google_ads'] as Record<string, unknown>) }
          : {};

      googleAds['oauth_token_state'] = 'connected';
      googleAds['enabled'] = true;
      // Só sobrescrevemos customer_id se exatamente um foi descoberto via API.
      // Caso contrário, deixamos a CP pedir ao user para escolher.
      if (uniqueCustomerId) {
        googleAds['customer_id'] = uniqueCustomerId;
      }
      integrations['google_ads'] = googleAds;
      const merged: Record<string, unknown> = {
        ...currentConfig,
        integrations,
      };

      await db
        .update(workspaces)
        .set({ config: jsonb(merged) })
        .where(eq(workspaces.id, workspaceId));
    } catch (err) {
      // O refresh_token JÁ foi persistido — não rolback. Logamos warning e seguimos
      // para audit + cache invalidation. A próxima chamada a getGoogleAdsConfig
      // ainda lerá o ciphertext, e a UI poderá pedir ao user pra confirmar
      // customer_id manualmente.
      safeLog('warn', {
        event:
          'integrations_google_oauth_callback_persist_config_failed_soft',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
    }

    // 8. Audit log — BR-AUDIT-001.
    //    metadata: SEM refresh_token, SEM access_token, SEM ciphertext.
    //    Inclui só prefixo mascarado do customer_id (se houver) + counts.
    const auditMetadata: Record<string, unknown> = {
      accessible_customers_count: accessibleCustomers.customer_ids.length,
      customer_id_masked: maskCustomerId(uniqueCustomerId),
      refresh_token_set: true,
      pii_key_version: encrypted.value.piiKeyVersion,
    };

    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          workspace_id: workspaceId,
          // Não temos um user_id confiável aqui (callback não tem Bearer);
          // identificamos o ator pela origem do flow.
          actor_id: 'oauth_callback',
          actor_type: 'system',
          action: 'workspace_google_ads_oauth_completed',
          entity_type: 'workspace_integration',
          entity_id: workspaceId,
          metadata: auditMetadata,
          request_id: requestId,
        });
      } catch (auditErr) {
        safeLog('warn', {
          event: '[AUDIT-PENDING] workspace_google_ads_oauth_completed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type:
            auditErr instanceof Error
              ? auditErr.constructor.name
              : typeof auditErr,
        });
      }
    } else {
      // Fallback: insert direto. Mesmo padrão de integrations-sendflow.ts.
      try {
        await db.insert(auditLog).values({
          workspaceId,
          actorId: 'oauth_callback',
          actorType: 'system',
          action: 'workspace_google_ads_oauth_completed',
          entityType: 'workspace_integration',
          entityId: workspaceId,
          // BR-PRIVACY-001: after carrega só metadata mascarado.
          after: auditMetadata,
          requestContext: { request_id: requestId },
        });
      } catch (auditErr) {
        safeLog('warn', {
          event:
            '[AUDIT-PENDING] workspace_google_ads_oauth_completed — fallback insert failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type:
            auditErr instanceof Error
              ? auditErr.constructor.name
              : typeof auditErr,
        });
      }
    }

    // 9. Invalida cache pra forçar refresh com o novo refresh_token.
    invalidateGoogleAdsAccessTokenCache(workspaceId);

    safeLog('info', {
      event: 'integrations_google_oauth_callback_ok',
      request_id: requestId,
      workspace_id: workspaceId,
      accessible_customers_count: accessibleCustomers.customer_ids.length,
      customer_id_masked: maskCustomerId(uniqueCustomerId),
    });

    return c.html(
      htmlPage({
        title: 'Conta Google Ads conectada',
        message:
          'Conexão estabelecida com sucesso. Volte ao painel para mapear seus eventos para conversion actions.',
        backUrl: cpBackUrl,
        status: 'ok',
      }),
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // T-14-007: GET /conversion-actions — lista conversion actions ENABLED.
  //
  // BR-RBAC-002: workspace_id do auth context — Bearer obrigatório.
  // BR-PRIVACY-001: nada de access_token/developer_token em logs/responses.
  // -------------------------------------------------------------------------
  route.get('/conversion-actions', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const actorId = extractBearerToken(c.req.header('Authorization'));
    if (!actorId) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid Authorization header',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      actorId;

    const db = deps?.getDb?.(c);
    if (!db) {
      safeLog('warn', {
        event: 'integrations_google_conversion_actions_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.json(
        {
          code: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    const masterKeyHex = c.env.PII_MASTER_KEY_V1;
    const oauthClientId = c.env.GOOGLE_OAUTH_CLIENT_ID;
    const oauthClientSecret = c.env.GOOGLE_OAUTH_CLIENT_SECRET;

    if (!masterKeyHex || !oauthClientId || !oauthClientSecret) {
      safeLog('warn', {
        event: 'integrations_google_conversion_actions_misconfigured',
        request_id: requestId,
        workspace_id: workspaceId,
        missing_master_key: !masterKeyHex,
        missing_client_id: !oauthClientId,
        missing_client_secret: !oauthClientSecret,
      });
      return c.json(
        {
          code: 'service_unavailable',
          message: 'Google OAuth not configured on this environment',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    const tokenResult = await getGoogleAdsAccessToken({
      db,
      workspaceId,
      masterKeyRegistry: { 1: masterKeyHex },
      envDeveloperToken: c.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? null,
      oauthClientId,
      oauthClientSecret,
      fetchFn,
    });

    if (!tokenResult.ok) {
      // Mapeamento erro tipado → HTTP. CP usa esses códigos para decidir UX.
      const code = tokenResult.error.code;
      switch (code) {
        case 'not_configured':
          return c.json(
            {
              code: 'google_ads_not_configured',
              message: 'Google Ads not connected for this workspace',
              request_id: requestId,
            },
            409,
            { 'X-Request-Id': requestId },
          );
        case 'invalid_state':
          return c.json(
            {
              code: 'google_ads_oauth_pending',
              message: 'Google Ads OAuth flow is incomplete',
              state: tokenResult.error.state,
              request_id: requestId,
            },
            409,
            { 'X-Request-Id': requestId },
          );
        case 'oauth_token_revoked':
          return c.json(
            {
              code: 'google_ads_token_revoked',
              message: 'Reconecte a conta Google Ads',
              request_id: requestId,
            },
            409,
            { 'X-Request-Id': requestId },
          );
        case 'decryption_failed':
        case 'oauth_refresh_failed':
        case 'db_error':
        default:
          return c.json(
            {
              code: 'internal_error',
              message: 'Failed to obtain Google Ads access token',
              request_id: requestId,
            },
            500,
            { 'X-Request-Id': requestId },
          );
      }
    }

    const apiResult = await listConversionActions({
      accessToken: tokenResult.value.accessToken,
      developerToken: tokenResult.value.developerToken,
      customerId: tokenResult.value.customerId,
      loginCustomerId: tokenResult.value.loginCustomerId,
      fetchFn,
    });

    if (!apiResult.ok) {
      // 401 da Google API é sinal forte de token revogado mid-flight (raro
      // dado que acabamos de pegar do cache/refresh, mas possível). Invalida
      // cache + sinaliza pra UI o caminho de reconexão.
      if (apiResult.status === 401) {
        invalidateGoogleAdsAccessTokenCache(workspaceId);
        safeLog('warn', {
          event: 'integrations_google_conversion_actions_api_401',
          request_id: requestId,
          workspace_id: workspaceId,
        });
        return c.json(
          {
            code: 'google_ads_token_revoked',
            message: 'Reconecte a conta Google Ads',
            request_id: requestId,
          },
          409,
          { 'X-Request-Id': requestId },
        );
      }

      // 403: developer_token sem permissão pro customer (configuração do operador).
      if (apiResult.status === 403) {
        safeLog('warn', {
          event: 'integrations_google_conversion_actions_api_403',
          request_id: requestId,
          workspace_id: workspaceId,
        });
        return c.json(
          {
            code: 'google_ads_api_forbidden',
            message:
              'Developer token sem permissão para este customer; verifique credenciais',
            request_id: requestId,
          },
          502,
          { 'X-Request-Id': requestId },
        );
      }

      safeLog('error', {
        event: 'integrations_google_conversion_actions_api_error',
        request_id: requestId,
        workspace_id: workspaceId,
        status: apiResult.status,
      });
      return c.json(
        {
          code: 'bad_gateway',
          message: 'Google Ads API returned an error',
          request_id: requestId,
        },
        502,
        { 'X-Request-Id': requestId },
      );
    }

    safeLog('info', {
      event: 'integrations_google_conversion_actions_ok',
      request_id: requestId,
      workspace_id: workspaceId,
      count: apiResult.conversion_actions.length,
    });

    return c.json(
      {
        conversion_actions: apiResult.conversion_actions,
        request_id: requestId,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance wired to createDb via Hyperdrive/DATABASE_URL.
// ---------------------------------------------------------------------------

export const integrationsGoogleRoute = createIntegrationsGoogleRoute({
  getDb: (c) => {
    const connString =
      c.env.DATABASE_URL ?? c.env.HYPERDRIVE?.connectionString;
    if (!connString) return undefined;
    return createDb(connString);
  },
});
