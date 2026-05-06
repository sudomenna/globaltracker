/**
 * lib/google-ads-config.ts — consolida config Google Ads de um workspace.
 *
 * Junta três fontes em um único trip ao DB (LEFT JOIN):
 *   (a) workspaces.config.integrations.google_ads (JSONB; customer_id,
 *       login_customer_id, conversion_actions, oauth_token_state, enabled),
 *   (b) workspace_integrations.google_ads_refresh_token_enc (coluna; ciphertext),
 *   (c) workspaces.google_ads_developer_token (coluna ou env var fallback).
 *
 * Expõe duas funções:
 *   - getGoogleAdsConfig(): config consolidada SEM decifrar refresh_token.
 *     Uso: eligibility checks, UI metadata, badges de health.
 *   - resolveGoogleAdsCredentials(): decifra refresh_token + resolve developer
 *     token, retornando tudo pronto pra OAuth refresh + Google Ads API call.
 *
 * Erros são tipados e retornados via Result<T, E>; nunca via throw.
 *
 * T-14-003 (Sprint 14, Onda 1) — refinamento de ADR-028.
 *
 * BR-PRIVACY-001: nunca logar refresh_token cru, ciphertext ou developer_token.
 *   Os Result<error> retornados também não carregam segredos — apenas códigos.
 * BR-RBAC-002: workspace_id é a âncora de tenancy; toda leitura é escopada por id.
 * INV-WI-001: workspace_integrations é 1:1 com workspaces (LEFT JOIN seguro).
 */

import { eq } from 'drizzle-orm';
import type { Db } from '@globaltracker/db';
import { workspaces, workspaceIntegrations } from '@globaltracker/db';
import {
  decryptPii,
  type MasterKeyRegistry,
  type PiiKeyVersion,
  type Result,
} from './pii.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GoogleAdsConfigError =
  | { code: 'not_configured'; message: string }
  | { code: 'invalid_state'; message: string; state?: string }
  | { code: 'decryption_failed'; message: string }
  | { code: 'db_error'; message: string };

/** canonical_event_name → Google Ads conversion_action_id (string id). */
export type CanonicalConversionMap = Record<string, string>;

/**
 * Estado OAuth do flow Google Ads (espelha o enum em routes/workspace-config.ts).
 * 'pending'   — flow iniciado mas ainda sem refresh_token persistido.
 * 'connected' — refresh_token presente e válido (assumido até erro 401 da API).
 * 'expired'   — refresh_token marcado expirado por dispatcher após falha auth.
 */
export type GoogleAdsOAuthState = 'pending' | 'connected' | 'expired';

/**
 * Config consolidada SEM refresh_token cru.
 *
 * Uso:
 *   - Eligibility checks (eligibility.ts) que precisam saber se há mapping de
 *     conversion_actions para um event_name.
 *   - UI/CP que precisa mostrar status, customer_id, mappings configurados.
 *
 * O campo `enabled` aqui é o EFETIVO: só true quando todos os pré-requisitos
 * estão presentes (ver computeEffectiveEnabled()). Isso evita que o caller
 * precise replicar a lógica de "está realmente pronto pra disparar?".
 */
export type GoogleAdsConfig = {
  customerId: string;
  loginCustomerId: string | null;
  oauthTokenState: GoogleAdsOAuthState;
  conversionActions: CanonicalConversionMap;
  enabled: boolean;
  hasRefreshToken: boolean;
  developerTokenSource: 'workspace' | 'env' | 'none';
};

/**
 * Config resolvida com refresh_token + developer_token em claro.
 * Uso EXCLUSIVO no momento de chamar a Google Ads API (passar pra
 * refreshAccessToken() de dispatchers/google-ads-conversion/oauth.ts).
 *
 * BR-PRIVACY-001: NUNCA serializar/logar este objeto.
 */
export type GoogleAdsResolvedConfig = GoogleAdsConfig & {
  refreshToken: string;
  developerToken: string;
};

export type GetGoogleAdsConfigOpts = {
  db: Db;
  workspaceId: string;
};

export type ResolveGoogleAdsCredentialsOpts = GetGoogleAdsConfigOpts & {
  masterKeyRegistry: MasterKeyRegistry;
  /**
   * Token developer global do operador (env var GOOGLE_ADS_DEVELOPER_TOKEN).
   * Usado como fallback quando workspaces.google_ads_developer_token é null.
   * Passe null/undefined explicitamente quando não houver fallback.
   */
  envDeveloperToken: string | null;
  /**
   * Versão da chave PII para decifrar o refresh_token.
   * Defaulta para 1 — não há coluna pii_key_version associada ao
   * google_ads_refresh_token_enc, então rotação futura exigirá migration.
   */
  piiKeyVersion?: PiiKeyVersion;
};

// ---------------------------------------------------------------------------
// Internal types & helpers
// ---------------------------------------------------------------------------

type RawConfigJsonb = Record<string, unknown> | string | null | undefined;

type RawGoogleAdsJsonb = {
  customer_id?: unknown;
  login_customer_id?: unknown;
  oauth_token_state?: unknown;
  conversion_actions?: unknown;
  enabled?: unknown;
};

type ParsedGoogleAdsJsonb = {
  customerId: string | null;
  loginCustomerId: string | null;
  oauthTokenState: GoogleAdsOAuthState;
  conversionActions: CanonicalConversionMap;
  enabledFlag: boolean;
};

/**
 * Parse defensivo de workspaces.config — alguns drivers retornam string,
 * outros objeto. Mesmo padrão usado em routes/workspace-config.ts.
 */
function parseConfigJsonb(raw: RawConfigJsonb): Record<string, unknown> {
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
    return raw;
  }
  return {};
}

function isOAuthState(value: unknown): value is GoogleAdsOAuthState {
  return value === 'pending' || value === 'connected' || value === 'expired';
}

/**
 * Extrai e normaliza o sub-objeto integrations.google_ads do JSONB cru.
 * Filtra tombstones (null values) do conversion_actions — T-14-001 aceita
 * null como tombstone via PATCH/deepMerge, mas registros antigos podem
 * ainda conter nulls residuais que não devem virar mappings ativos.
 */
function parseGoogleAdsBlob(
  rawConfig: Record<string, unknown>,
): ParsedGoogleAdsJsonb {
  const integrations =
    rawConfig['integrations'] &&
    typeof rawConfig['integrations'] === 'object' &&
    !Array.isArray(rawConfig['integrations'])
      ? (rawConfig['integrations'] as Record<string, unknown>)
      : {};

  const blob =
    integrations['google_ads'] &&
    typeof integrations['google_ads'] === 'object' &&
    !Array.isArray(integrations['google_ads'])
      ? (integrations['google_ads'] as RawGoogleAdsJsonb)
      : {};

  const customerId =
    typeof blob.customer_id === 'string' && blob.customer_id.length > 0
      ? blob.customer_id
      : null;

  const loginCustomerId =
    typeof blob.login_customer_id === 'string' &&
    blob.login_customer_id.length > 0
      ? blob.login_customer_id
      : null;

  const oauthTokenState: GoogleAdsOAuthState = isOAuthState(
    blob.oauth_token_state,
  )
    ? blob.oauth_token_state
    : 'pending';

  // BR-API-PATCH-NULL: filtra tombstones residuais do JSONB; só mantém pares
  // string→string válidos. Resulta em CanonicalConversionMap puro.
  const conversionActions: CanonicalConversionMap = {};
  if (
    blob.conversion_actions &&
    typeof blob.conversion_actions === 'object' &&
    !Array.isArray(blob.conversion_actions)
  ) {
    for (const [key, value] of Object.entries(
      blob.conversion_actions as Record<string, unknown>,
    )) {
      if (typeof value === 'string' && value.length > 0) {
        conversionActions[key] = value;
      }
    }
  }

  const enabledFlag = blob.enabled === true;

  return {
    customerId,
    loginCustomerId,
    oauthTokenState,
    conversionActions,
    enabledFlag,
  };
}

/**
 * Decide o `enabled` EFETIVO. Só true quando todos os pré-requisitos pra
 * disparar uma conversion upload estão presentes — assim quem consome
 * apenas precisa checar `config.enabled`.
 */
function computeEffectiveEnabled(args: {
  enabledFlag: boolean;
  hasCustomerId: boolean;
  oauthTokenState: GoogleAdsOAuthState;
  hasRefreshToken: boolean;
  developerTokenSource: GoogleAdsConfig['developerTokenSource'];
}): boolean {
  return (
    args.enabledFlag &&
    args.hasCustomerId &&
    args.oauthTokenState === 'connected' &&
    args.hasRefreshToken &&
    args.developerTokenSource !== 'none'
  );
}

// ---------------------------------------------------------------------------
// Single DB read — used by both public functions
// ---------------------------------------------------------------------------

type LoadedRow = {
  config: RawConfigJsonb;
  developerToken: string | null;
  refreshTokenEnc: string | null;
};

async function loadRow(
  opts: GetGoogleAdsConfigOpts,
): Promise<Result<LoadedRow | null, GoogleAdsConfigError>> {
  try {
    // INV-WI-001: workspace_integrations é 1:1 com workspaces — leftJoin é seguro.
    // Single SELECT minimiza round-trips no edge runtime.
    const rows = await opts.db
      .select({
        config: workspaces.config,
        developerToken: workspaces.googleAdsDeveloperToken,
        refreshTokenEnc: workspaceIntegrations.googleAdsRefreshTokenEnc,
      })
      .from(workspaces)
      .leftJoin(
        workspaceIntegrations,
        eq(workspaceIntegrations.workspaceId, workspaces.id),
      )
      .where(eq(workspaces.id, opts.workspaceId))
      .limit(1);

    const row = rows[0];
    if (!row) return { ok: true, value: null };

    return {
      ok: true,
      value: {
        config: row.config as RawConfigJsonb,
        developerToken: row.developerToken ?? null,
        refreshTokenEnc: row.refreshTokenEnc ?? null,
      },
    };
  } catch {
    // BR-PRIVACY-001: não vazar detalhes do erro original (poderia conter
    // fragmentos de query). Mensagem genérica.
    return {
      ok: false,
      error: {
        code: 'db_error',
        message: 'Failed to load Google Ads config',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lê config consolidada SEM decifrar refresh_token.
 *
 * Retornos:
 *   - ok=true: config com `enabled` efetivo e flags auxiliares.
 *   - error.not_configured: workspace inexistente OU sem customer_id no JSONB
 *     (sinal claro de que nada foi configurado ainda).
 *
 * Não retorna invalid_state — esta função é tolerante a estados parciais
 * (ex.: customer_id sem refresh_token), apenas reporta via campos do retorno.
 *
 * BR-PRIVACY-001: o objeto retornado nunca contém ciphertext nem developer_token.
 */
export async function getGoogleAdsConfig(
  opts: GetGoogleAdsConfigOpts,
): Promise<Result<GoogleAdsConfig, GoogleAdsConfigError>> {
  const loaded = await loadRow(opts);
  if (!loaded.ok) return loaded;

  if (loaded.value === null) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: 'Workspace not found',
      },
    };
  }

  const row = loaded.value;
  const rawConfig = parseConfigJsonb(row.config);
  const parsed = parseGoogleAdsBlob(rawConfig);

  if (!parsed.customerId) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: 'Google Ads customer_id not configured',
      },
    };
  }

  const hasRefreshToken = row.refreshTokenEnc !== null;
  const developerTokenSource: GoogleAdsConfig['developerTokenSource'] =
    row.developerToken !== null ? 'workspace' : 'none';

  const enabled = computeEffectiveEnabled({
    enabledFlag: parsed.enabledFlag,
    hasCustomerId: true,
    oauthTokenState: parsed.oauthTokenState,
    hasRefreshToken,
    developerTokenSource,
  });

  return {
    ok: true,
    value: {
      customerId: parsed.customerId,
      loginCustomerId: parsed.loginCustomerId,
      oauthTokenState: parsed.oauthTokenState,
      conversionActions: parsed.conversionActions,
      enabled,
      hasRefreshToken,
      developerTokenSource,
    },
  };
}

/**
 * Lê config + decifra refresh_token + resolve developer_token (workspace ou env).
 *
 * Falhas tipadas:
 *   - not_configured: workspace inexistente, sem customer_id, ou sem refresh_token.
 *   - invalid_state: oauth_token_state !== 'connected' (ex.: 'expired' após 401).
 *   - decryption_failed: decryptPii retornou erro (chave errada ou ciphertext corrompido).
 *   - db_error: erro inesperado de DB.
 *
 * O developer_token é resolvido na seguinte ordem:
 *   1. workspaces.google_ads_developer_token (se não-null) — fonte 'workspace'
 *   2. opts.envDeveloperToken (env var global) — fonte 'env'
 *   3. nenhum disponível → not_configured
 *
 * BR-PRIVACY-001: refresh_token decifrado e developer_token estão no retorno
 * APENAS pra serem repassados imediatamente ao adapter; nunca persistir nem logar.
 */
export async function resolveGoogleAdsCredentials(
  opts: ResolveGoogleAdsCredentialsOpts,
): Promise<Result<GoogleAdsResolvedConfig, GoogleAdsConfigError>> {
  const loaded = await loadRow(opts);
  if (!loaded.ok) return loaded;

  if (loaded.value === null) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: 'Workspace not found',
      },
    };
  }

  const row = loaded.value;
  const rawConfig = parseConfigJsonb(row.config);
  const parsed = parseGoogleAdsBlob(rawConfig);

  if (!parsed.customerId) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: 'Google Ads customer_id not configured',
      },
    };
  }

  if (parsed.oauthTokenState !== 'connected') {
    return {
      ok: false,
      error: {
        code: 'invalid_state',
        message: `Google Ads OAuth not connected (state=${parsed.oauthTokenState})`,
        state: parsed.oauthTokenState,
      },
    };
  }

  if (!row.refreshTokenEnc) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: 'Google Ads refresh_token not stored',
      },
    };
  }

  // Resolve developer_token: workspace > env > nenhum.
  let developerToken: string | null = null;
  let developerTokenSource: GoogleAdsConfig['developerTokenSource'] = 'none';
  if (row.developerToken !== null && row.developerToken.length > 0) {
    developerToken = row.developerToken;
    developerTokenSource = 'workspace';
  } else if (
    opts.envDeveloperToken !== null &&
    opts.envDeveloperToken !== undefined &&
    opts.envDeveloperToken.length > 0
  ) {
    developerToken = opts.envDeveloperToken;
    developerTokenSource = 'env';
  }

  if (developerToken === null) {
    return {
      ok: false,
      error: {
        code: 'not_configured',
        message: 'Google Ads developer_token not available (workspace null, env empty)',
      },
    };
  }

  // BR-PRIVACY-003/004: decryptPii retorna Result<string, PiiError>. Mapeamos
  // PiiError → decryption_failed sem repassar a mensagem original (poderia
  // mencionar key version/wrong workspace — info útil pra atacante).
  const decrypted = await decryptPii(
    row.refreshTokenEnc,
    opts.workspaceId,
    opts.masterKeyRegistry,
    opts.piiKeyVersion ?? 1,
  );

  if (!decrypted.ok) {
    return {
      ok: false,
      error: {
        code: 'decryption_failed',
        message: 'Failed to decrypt Google Ads refresh_token',
      },
    };
  }

  // Neste ponto todos os pré-requisitos estão satisfeitos; enabled efetivo é
  // garantidamente true se o flag JSONB estiver true. Mantemos o cálculo
  // explícito para o caller que ainda queira respeitar `enabled=false` como
  // pausa manual operacional.
  const enabled = computeEffectiveEnabled({
    enabledFlag: parsed.enabledFlag,
    hasCustomerId: true,
    oauthTokenState: parsed.oauthTokenState,
    hasRefreshToken: true,
    developerTokenSource,
  });

  return {
    ok: true,
    value: {
      customerId: parsed.customerId,
      loginCustomerId: parsed.loginCustomerId,
      oauthTokenState: parsed.oauthTokenState,
      conversionActions: parsed.conversionActions,
      enabled,
      hasRefreshToken: true,
      developerTokenSource,
      refreshToken: decrypted.value,
      developerToken,
    },
  };
}
