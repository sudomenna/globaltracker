/**
 * Lead token helper — HMAC-SHA256 stateful token for lead re-identification.
 *
 * The token is the identifier for a `lead_tokens` row in the DB (OQ-007 closed:
 * lead_token is stateful). The HMAC payload encodes workspaceId, leadId, and
 * issuedAt so the Edge can do a fast lookup before hitting the DB.
 *
 * Uses Web Crypto API (crypto.subtle) only — no Node.js builtins.
 * Compatible with Cloudflare Workers runtime.
 *
 * BR-IDENTITY-005: lead_token HMAC has mandatory binding to page_token_hash.
 * INV-IDENTITY-006: LeadToken valid only with matching page_token_hash claim.
 *
 * T-2-008: issueLeadToken — stores token_hash in lead_tokens DB row.
 * T-2-010: validateLeadToken — validates against DB row including page_token_hash.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type LeadTokenError =
  | { code: 'invalid_token_format'; message: string }
  | { code: 'hmac_verification_failed'; message: string }
  | { code: 'token_generation_failed'; message: string };

export type IssueLeadTokenError =
  | { code: 'token_generation_failed'; message: string }
  | { code: 'db_error'; message: string };

export type IssueLeadTokenResult = {
  token_clear: string;
  expires_at: Date;
  token_id: string;
};

export type ValidateLeadTokenError =
  | { code: 'invalid_token'; message: string }
  | { code: 'hmac_invalid'; message: string }
  | { code: 'expired'; message: string }
  | { code: 'revoked'; message: string }
  | { code: 'page_mismatch'; message: string }
  | { code: 'db_error'; message: string };

/** Decoded payload extracted from a lead token (no signature verification). */
export interface LeadTokenPayload {
  leadId: string;
  workspaceId: string;
  issuedAt: number; // Unix timestamp in seconds
}

// ---------------------------------------------------------------------------
// DB import for stateful token operations (T-2-008, T-2-010)
// ---------------------------------------------------------------------------

import type { Db } from '@globaltracker/db';
import { leadTokens } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Separator used between payload fields in the HMAC message. */
const FIELD_SEP = ':';
/** Separator between the base64url payload and the HMAC signature. */
const TOKEN_SEP = '.';

// ---------------------------------------------------------------------------
// Internal helpers
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

/** Encode a payload string to base64url. */
function encodePayload(
  workspaceId: string,
  leadId: string,
  issuedAt: number,
): string {
  const raw = [workspaceId, leadId, String(issuedAt)].join(FIELD_SEP);
  return bytesToBase64url(new TextEncoder().encode(raw));
}

/** Decode and split a base64url payload back to its fields. */
function decodePayload(
  encoded: string,
): { workspaceId: string; leadId: string; issuedAt: number } | null {
  try {
    const raw = new TextDecoder().decode(base64urlToBytes(encoded));
    const parts = raw.split(FIELD_SEP);
    // workspaceId and leadId may themselves contain colons (UUIDs don't, but
    // we enforce exactly 3 parts: workspaceId, leadId, issuedAt).
    if (parts.length < 3) return null;
    // issuedAt is the last part; leadId is second; workspaceId is everything before
    const issuedAt = Number(parts[parts.length - 1]);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
    const leadId = parts[parts.length - 2] as string;
    const workspaceId = parts.slice(0, parts.length - 2).join(FIELD_SEP);
    if (!workspaceId || !leadId) return null;
    return { workspaceId, leadId, issuedAt };
  } catch {
    return null;
  }
}

async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a lead token (HMAC-SHA256) binding workspaceId + leadId + timestamp.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`
 *
 * BR-IDENTITY-005: token claim includes workspaceId so it cannot be reused
 * across workspaces. The page_token_hash binding is enforced at validation
 * time via the `lead_tokens` DB row (stateful, OQ-007 closed).
 *
 * @param leadId      - internal lead UUID
 * @param workspaceId - workspace UUID
 * @param secret      - HMAC signing secret (LEAD_TOKEN_HMAC_SECRET)
 * @param nowSec      - override for current timestamp (defaults to Date.now()/1000)
 */
export async function generateLeadToken(
  leadId: string,
  workspaceId: string,
  secret: Uint8Array,
  nowSec?: number,
): Promise<Result<string, LeadTokenError>> {
  // BR-IDENTITY-005: lead_token HMAC has mandatory binding to page_token_hash
  // The page_token_hash binding is stored in the lead_tokens DB row (stateful).
  // The token itself embeds workspace+lead+timestamp for fast Edge lookup.
  try {
    const issuedAt = nowSec ?? Math.floor(Date.now() / 1000);
    const payloadEncoded = encodePayload(workspaceId, leadId, issuedAt);
    const messageBytes = new TextEncoder().encode(payloadEncoded);

    const key = await importHmacKey(secret);
    const sigBuffer = await crypto.subtle.sign('HMAC', key, messageBytes);
    const sigEncoded = bytesToBase64url(new Uint8Array(sigBuffer));

    return { ok: true, value: `${payloadEncoded}${TOKEN_SEP}${sigEncoded}` };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'token_generation_failed',
        message: err instanceof Error ? err.message : 'HMAC sign error',
      },
    };
  }
}

/**
 * Verify a lead token using timing-safe HMAC comparison.
 *
 * Confirms that the token was issued for the exact (leadId, workspaceId) pair
 * and has not been tampered with. Does NOT check expiry or revocation — those
 * are enforced by the DB row in `lead_tokens`.
 *
 * BR-IDENTITY-005: timing-safe compare prevents oracle attacks.
 * INV-IDENTITY-006: caller must separately verify page_token_hash against DB row.
 *
 * @returns `true` if the token is structurally valid and signature matches.
 */
export async function verifyLeadToken(
  token: string,
  leadId: string,
  workspaceId: string,
  secret: Uint8Array,
): Promise<boolean> {
  const parsed = parseLeadToken(token);
  if (!parsed) return false;

  // Claim check — token must match the supplied leadId + workspaceId
  if (parsed.leadId !== leadId || parsed.workspaceId !== workspaceId)
    return false;

  // Re-derive expected signature
  const sepIndex = token.lastIndexOf(TOKEN_SEP);
  if (sepIndex < 0) return false;
  const payloadPart = token.slice(0, sepIndex);
  const sigPart = token.slice(sepIndex + 1);

  try {
    const key = await importHmacKey(secret);
    const messageBytes = new TextEncoder().encode(payloadPart);
    const providedSig = base64urlToBytes(sigPart);

    // BR-IDENTITY-005: timing-safe compare via crypto.subtle.verify
    return await crypto.subtle.verify('HMAC', key, providedSig, messageBytes);
  } catch {
    return false;
  }
}

/**
 * Parse a lead token and extract its payload WITHOUT verifying the signature.
 *
 * Use this for a fast DB lookup before running the full HMAC verification.
 * Never trust the returned fields for authorization — always follow up with
 * `verifyLeadToken()` or a DB validation.
 *
 * INV-IDENTITY-006: parse only extracts claims; validity requires DB check.
 *
 * @returns Decoded payload or `null` if the token format is invalid.
 */
export function parseLeadToken(token: string): LeadTokenPayload | null {
  if (typeof token !== 'string' || !token) return null;

  const sepIndex = token.lastIndexOf(TOKEN_SEP);
  if (sepIndex < 1) return null; // need at least one char in payload

  const payloadPart = token.slice(0, sepIndex);
  if (!payloadPart) return null;

  const decoded = decodePayload(payloadPart);
  if (!decoded) return null;

  return {
    leadId: decoded.leadId,
    workspaceId: decoded.workspaceId,
    issuedAt: decoded.issuedAt,
  };
}

// ---------------------------------------------------------------------------
// SHA-256 hex helper (Web Crypto only — CF Workers compatible)
// ---------------------------------------------------------------------------

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// T-2-008: issueLeadToken — generate + persist to lead_tokens
// ---------------------------------------------------------------------------

/**
 * Issue a new lead token: generate HMAC token, store token_hash in DB.
 *
 * Steps:
 *   1. generateLeadToken(lead_id, workspace_id, hmac_secret) → token_clear
 *   2. token_hash = SHA-256(token_clear) as 64-char hex
 *   3. Insert row into lead_tokens
 *   4. Return { token_clear, expires_at, token_id }
 *
 * BR-IDENTITY-005: HMAC secret from Wrangler secret; token_clear never logged.
 * INV-IDENTITY-006: page_token_hash stored in DB row to enforce page binding.
 *
 * @param leadId          - internal lead UUID
 * @param workspaceId     - workspace UUID
 * @param pageTokenHash   - SHA-256 hex of the page_token (from X-Funil-Site header)
 * @param ttlDays         - token lifetime in days (default 60)
 * @param db              - Drizzle DB instance (DI)
 * @param hmacSecret      - HMAC signing secret bytes
 */
export async function issueLeadToken(
  leadId: string,
  workspaceId: string,
  pageTokenHash: string,
  ttlDays: number,
  db: Db,
  hmacSecret: Uint8Array,
): Promise<Result<IssueLeadTokenResult, IssueLeadTokenError>> {
  // Step 1: generate HMAC token
  // BR-IDENTITY-005: token HMAC signed with workspace-scoped secret
  const genResult = await generateLeadToken(leadId, workspaceId, hmacSecret);
  if (!genResult.ok) {
    return {
      ok: false,
      error: {
        code: 'token_generation_failed',
        message: genResult.error.message,
      },
    };
  }

  const tokenClear = genResult.value;

  // Step 2: token_hash = SHA-256(token_clear)
  // ADR-006: DB stores only the hash — clear token never persisted
  const tokenHash = await sha256Hex(tokenClear);

  // Step 3: compute expires_at
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  // Step 4: insert into lead_tokens
  try {
    const inserted = await db
      .insert(leadTokens)
      .values({
        workspaceId,
        leadId,
        tokenHash,
        pageTokenHash,
        issuedAt: now,
        expiresAt,
      })
      .returning({ id: leadTokens.id });

    const row = inserted[0];
    if (!row) {
      return {
        ok: false,
        error: {
          code: 'db_error',
          message: 'lead_tokens insert returned no row',
        },
      };
    }

    return {
      ok: true,
      value: {
        token_clear: tokenClear,
        expires_at: expiresAt,
        token_id: row.id,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'db_error',
        message: err instanceof Error ? err.message : 'Unknown DB error',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// T-2-010: validateLeadToken — verify HMAC + DB lookup + page binding
// ---------------------------------------------------------------------------

/**
 * Validate a lead token presented in the __ftk cookie.
 *
 * Steps:
 *   1. parseLeadToken(token_clear) → extract leadId, workspaceId
 *   2. verifyLeadToken(HMAC) → timing-safe signature check
 *   3. Compute token_hash = SHA-256(token_clear)
 *   4. Fetch DB row by token_hash + workspace_id
 *   5. Check: revoked_at IS NULL, expires_at > now, page_token_hash matches
 *   6. Update last_used_at; return { lead_id }
 *
 * BR-IDENTITY-005: HMAC verified before DB lookup — prevents oracle attack.
 * INV-IDENTITY-006: page_token_hash must match current page — token invalid elsewhere.
 * BR-PRIVACY-001: on failure, callers must not log the token value.
 *
 * @param tokenClear            - raw token from cookie (never log this)
 * @param currentPageTokenHash  - SHA-256 hex of the current page_token
 * @param db                    - Drizzle DB instance (DI)
 * @param hmacSecret            - HMAC signing secret bytes
 */
export async function validateLeadToken(
  tokenClear: string,
  currentPageTokenHash: string,
  db: Db,
  hmacSecret: Uint8Array,
): Promise<Result<{ lead_id: string }, ValidateLeadTokenError>> {
  // Step 1: parse token (extract claims — no trust without HMAC verify)
  const parsed = parseLeadToken(tokenClear);
  if (!parsed) {
    return {
      ok: false,
      error: { code: 'invalid_token', message: 'Token format is invalid' },
    };
  }

  // Step 2: HMAC verification — timing-safe
  // BR-IDENTITY-005: timing-safe compare via crypto.subtle.verify
  const hmacValid = await verifyLeadToken(
    tokenClear,
    parsed.leadId,
    parsed.workspaceId,
    hmacSecret,
  );
  if (!hmacValid) {
    return {
      ok: false,
      error: {
        code: 'hmac_invalid',
        message: 'Token HMAC signature is invalid',
      },
    };
  }

  // Step 3: compute token_hash for DB lookup
  const tokenHash = await sha256Hex(tokenClear);

  // Step 4: fetch DB row
  let rows: Array<{
    id: string;
    leadId: string;
    workspaceId: string;
    pageTokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
  }>;

  try {
    rows = await db
      .select({
        id: leadTokens.id,
        leadId: leadTokens.leadId,
        workspaceId: leadTokens.workspaceId,
        pageTokenHash: leadTokens.pageTokenHash,
        expiresAt: leadTokens.expiresAt,
        revokedAt: leadTokens.revokedAt,
      })
      .from(leadTokens)
      .where(
        and(
          eq(leadTokens.tokenHash, tokenHash),
          eq(leadTokens.workspaceId, parsed.workspaceId),
        ),
      )
      .limit(1);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'db_error',
        message: err instanceof Error ? err.message : 'Unknown DB error',
      },
    };
  }

  const row = rows[0];
  if (!row) {
    // Token hash not found in DB — tampered or already expired+purged
    return {
      ok: false,
      error: { code: 'invalid_token', message: 'Token not found in DB' },
    };
  }

  // Step 5a: check revocation
  if (row.revokedAt !== null) {
    return {
      ok: false,
      error: { code: 'revoked', message: 'Token has been revoked' },
    };
  }

  // Step 5b: check expiry
  if (row.expiresAt.getTime() <= Date.now()) {
    return {
      ok: false,
      error: { code: 'expired', message: 'Token has expired' },
    };
  }

  // Step 5c: page binding — INV-IDENTITY-006
  // BR-IDENTITY-005: token valid only on the page it was issued for
  if (row.pageTokenHash !== currentPageTokenHash) {
    return {
      ok: false,
      error: {
        code: 'page_mismatch',
        message: 'Token is not valid for the current page',
      },
    };
  }

  // Step 6: update last_used_at (fire-and-forget: failure is non-fatal)
  try {
    await db
      .update(leadTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(leadTokens.id, row.id));
  } catch {
    // Non-fatal: token is valid even if last_used_at update fails
  }

  return {
    ok: true,
    value: { lead_id: row.leadId },
  };
}
