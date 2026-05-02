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
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type LeadTokenError =
  | { code: 'invalid_token_format'; message: string }
  | { code: 'hmac_verification_failed'; message: string }
  | { code: 'token_generation_failed'; message: string };

/** Decoded payload extracted from a lead token (no signature verification). */
export interface LeadTokenPayload {
  leadId: string;
  workspaceId: string;
  issuedAt: number; // Unix timestamp in seconds
}

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
