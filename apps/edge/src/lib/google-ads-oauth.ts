/**
 * lib/google-ads-oauth.ts — Cache + auto-refresh de access_token Google Ads.
 *
 * Cloudflare Workers V8 isolates compartilham memória entre requests do
 * mesmo isolate (~5-15min de vida). Usamos um Map top-level com TTL pra
 * deduplicar refresh dentro de uma janela curta — um access_token Google
 * dura 1h, então pegar do cache 100s a fio em vez de chamar
 * oauth2.googleapis.com 100x economiza latência e quota.
 *
 * Se o refresh_token foi revogado (Google retorna `invalid_grant`), marcamos
 * `oauth_token_state='expired'` no JSONB do workspace para que a UI mostre o
 * botão "Reconectar Google Ads". O cache do workspace é invalidado também,
 * pra evitar servir um access_token derivado de um refresh_token que ainda
 * esteja em flight em outro request.
 *
 * Concorrência: dois requests simultâneos no mesmo isolate podem disparar
 * refreshAccessToken em paralelo na primeira chamada. Aceitável — o endpoint
 * de token do Google é idempotente o bastante (cada chamada gera um access
 * token novo, mas todos servem). Não introduzimos locking pra não pagar
 * complexidade que não nos blinda contra o caso real (múltiplos isolates).
 *
 * T-14-006 (Sprint 14, Onda 2) — refinamento de ADR-028.
 *
 * BR-PRIVACY-001: nenhum log com refresh_token cru, access_token, ciphertext
 *   ou developer_token. Logs carregam apenas workspace_id + códigos de evento.
 * BR-RBAC-002: workspace_id é a âncora de tenancy — também é a chave do cache.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '@globaltracker/db';
import { workspaces } from '@globaltracker/db';
import type { MasterKeyRegistry, Result } from './pii.js';
import {
  resolveGoogleAdsCredentials,
  type GoogleAdsConfigError,
} from './google-ads-config.js';
import { refreshAccessToken } from '../dispatchers/google-ads-conversion/oauth.js';
import { jsonb } from './jsonb-cast.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * TTL do cache de access_token. 5min — bem abaixo do 1h de validade real do
 * access_token do Google. Deixa folga pra refresh tardio em caso de clock
 * skew leve, e mantém o blast radius pequeno se um refresh_token for revogado
 * (até 5min servindo token "stale" antes de tentar refresh e detectar revoke).
 */
const ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CacheEntry = {
  accessToken: string;
  expiresAt: number; // ms epoch — quando o entry deve ser invalidado
  customerId: string;
  loginCustomerId: string | null;
  developerToken: string;
};

export type GoogleAdsAccessTokenError =
  | GoogleAdsConfigError
  | { code: 'oauth_refresh_failed'; message: string }
  | { code: 'oauth_token_revoked'; message: string };

export type GoogleAdsAccessTokenResult = {
  accessToken: string;
  customerId: string;
  loginCustomerId: string | null;
  developerToken: string;
};

export type GetGoogleAdsAccessTokenOpts = {
  db: Db;
  workspaceId: string;
  masterKeyRegistry: MasterKeyRegistry;
  /** Token developer global (env var GOOGLE_ADS_DEVELOPER_TOKEN). null se ausente. */
  envDeveloperToken: string | null;
  oauthClientId: string;
  oauthClientSecret: string;
  /** Override pra testes — default usa global fetch. */
  fetchFn?: typeof fetch;
  /** Override pra testes — default Date.now(). */
  nowMs?: () => number;
};

// ---------------------------------------------------------------------------
// Top-level cache
// Vive enquanto o V8 isolate vive. Stateless entre isolates — diferentes
// workers no datacenter ainda farão refresh independente, mas isso é o trade
// aceitável pra não depender de KV/Hyperdrive no caminho quente.
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Helpers — invalid_grant detection + DB write
// ---------------------------------------------------------------------------

/**
 * Detecta se o erro de refreshAccessToken é o caso `invalid_grant` (refresh
 * token revogado/expirado). A função em `dispatchers/google-ads-conversion/oauth.ts`
 * lança `Error` com mensagem `google_oauth_error: invalid_grant — ...` nesse caso.
 */
function isInvalidGrantError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Match defensivo: o prefixo é 'google_oauth_error:' e o sub-código é
  // 'invalid_grant'. Aceitamos qualquer ocorrência da string pra robustez.
  return err.message.includes('invalid_grant');
}

/**
 * Marca `workspaces.config.integrations.google_ads.oauth_token_state='expired'`
 * via SELECT → JS deepMerge → UPDATE com cast `::jsonb` explícito. Mesmo padrão
 * de `routes/workspace-config.ts` (T-13-013): o driver Hyperdrive grava
 * jsonb-string sem o helper `jsonb()`.
 *
 * Erros aqui NÃO propagam — caller já decidiu retornar `oauth_token_revoked`.
 * Se o UPDATE falhar, ainda invalidamos o cache e logamos warning; o próximo
 * request fará novo refresh e tentará marcar de novo.
 *
 * BR-PRIVACY-001: log apenas workspace_id + error_type, nunca detalhes.
 */
async function markOAuthTokenExpired(
  db: Db,
  workspaceId: string,
): Promise<void> {
  try {
    const rows = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const rawCfg = rows[0]?.config;
    const currentConfig: Record<string, unknown> =
      typeof rawCfg === 'string'
        ? (() => {
            try {
              return JSON.parse(rawCfg) as Record<string, unknown>;
            } catch {
              return {};
            }
          })()
        : ((rawCfg as Record<string, unknown> | null | undefined) ?? {});

    // deepMerge inline pra não acoplar com routes/. Só precisamos de um path:
    // integrations.google_ads.oauth_token_state. Preservamos o resto do JSONB.
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

    googleAds['oauth_token_state'] = 'expired';
    integrations['google_ads'] = googleAds;
    const merged: Record<string, unknown> = {
      ...currentConfig,
      integrations,
    };

    // T-13-013: jsonb() força cast `::jsonb`. Sem ele, Hyperdrive driver
    // grava jsonb-string em vez de jsonb-object.
    await db
      .update(workspaces)
      .set({ config: jsonb(merged) })
      .where(eq(workspaces.id, workspaceId));
  } catch (err) {
    // BR-PRIVACY-001: nunca logar detalhes do erro original.
    safeLog('warn', {
      event: 'google_ads_oauth_token_expired_persist_failed',
      workspace_id: workspaceId,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retorna um access_token Google Ads válido pra um workspace.
 *
 * Fluxo:
 *   1. Cache hit (não expirado) → retorna cache.
 *   2. Resolve credentials (refresh_token decifrado + developer_token + customer_id).
 *   3. Refresh access_token via Google OAuth2.
 *      - `invalid_grant`: marca `oauth_token_state='expired'` no DB + retorna
 *        `oauth_token_revoked`. Cache do workspace invalidado.
 *      - Outros erros: retorna `oauth_refresh_failed` (mensagem genérica).
 *   4. Sucesso: grava cache (TTL 5min) e retorna.
 *
 * BR-PRIVACY-001: o objeto retornado contém access_token + developer_token; é
 *   pra ser repassado imediatamente ao adapter Google Ads, NUNCA logado nem persistido.
 */
export async function getGoogleAdsAccessToken(
  opts: GetGoogleAdsAccessTokenOpts,
): Promise<Result<GoogleAdsAccessTokenResult, GoogleAdsAccessTokenError>> {
  const now = opts.nowMs ? opts.nowMs() : Date.now();

  // -------------------------------------------------------------------------
  // 1. Cache hit
  // BR-RBAC-002: workspace_id é a chave — sem leak cross-workspace possível.
  // -------------------------------------------------------------------------
  const cached = cache.get(opts.workspaceId);
  if (cached && cached.expiresAt > now) {
    safeLog('info', {
      event: 'google_ads_access_token_cache_hit',
      workspace_id: opts.workspaceId,
    });
    return {
      ok: true,
      value: {
        accessToken: cached.accessToken,
        customerId: cached.customerId,
        loginCustomerId: cached.loginCustomerId,
        developerToken: cached.developerToken,
      },
    };
  }

  // Entry expirado: remove pra liberar memória antes do refresh.
  if (cached) {
    cache.delete(opts.workspaceId);
  }

  // -------------------------------------------------------------------------
  // 2. Resolve credentials (decifra refresh_token + resolve developer_token)
  // -------------------------------------------------------------------------
  const credentials = await resolveGoogleAdsCredentials({
    db: opts.db,
    workspaceId: opts.workspaceId,
    masterKeyRegistry: opts.masterKeyRegistry,
    envDeveloperToken: opts.envDeveloperToken,
  });

  if (!credentials.ok) {
    // Propaga o erro tipado (not_configured, invalid_state, decryption_failed, db_error).
    return credentials;
  }

  // -------------------------------------------------------------------------
  // 3. Refresh access_token
  // -------------------------------------------------------------------------
  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(
      {
        clientId: opts.oauthClientId,
        clientSecret: opts.oauthClientSecret,
        refreshToken: credentials.value.refreshToken,
      },
      opts.fetchFn,
    );
  } catch (err) {
    if (isInvalidGrantError(err)) {
      // BR-PRIVACY-001: marca DB + invalida cache; logging sem detalhes.
      await markOAuthTokenExpired(opts.db, opts.workspaceId);
      cache.delete(opts.workspaceId);
      safeLog('warn', {
        event: 'google_ads_access_token_revoked',
        workspace_id: opts.workspaceId,
      });
      return {
        ok: false,
        error: {
          code: 'oauth_token_revoked',
          message: 'Google Ads refresh_token was revoked or expired',
        },
      };
    }

    // BR-PRIVACY-001: mensagem genérica — err.message poderia conter fragmentos
    // do response do Google que o atacante pudesse usar pra distinguir falhas.
    safeLog('error', {
      event: 'google_ads_access_token_refresh_failed',
      workspace_id: opts.workspaceId,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return {
      ok: false,
      error: {
        code: 'oauth_refresh_failed',
        message: 'oauth_refresh_failed',
      },
    };
  }

  // -------------------------------------------------------------------------
  // 4. Cache + return
  // -------------------------------------------------------------------------
  const entry: CacheEntry = {
    accessToken,
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
    customerId: credentials.value.customerId,
    loginCustomerId: credentials.value.loginCustomerId,
    developerToken: credentials.value.developerToken,
  };
  cache.set(opts.workspaceId, entry);

  safeLog('info', {
    event: 'google_ads_access_token_refresh_ok',
    workspace_id: opts.workspaceId,
  });

  return {
    ok: true,
    value: {
      accessToken: entry.accessToken,
      customerId: entry.customerId,
      loginCustomerId: entry.loginCustomerId,
      developerToken: entry.developerToken,
    },
  };
}

/**
 * Limpa cache de um workspace específico. Chamar após reconexão OAuth
 * (refresh_token novo gravado) pra forçar refresh imediato em vez de servir
 * um access_token derivado do refresh_token antigo.
 */
export function invalidateGoogleAdsAccessTokenCache(workspaceId: string): void {
  cache.delete(workspaceId);
}

/**
 * Limpa todo o cache. Uso exclusivo em testes pra isolar runs.
 */
export function clearGoogleAdsAccessTokenCacheForTests(): void {
  cache.clear();
}
