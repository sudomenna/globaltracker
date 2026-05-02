/**
 * PII helper — hashing and AES-256-GCM encryption per workspace.
 *
 * Uses Web Crypto API (crypto.subtle) only — no Node.js builtins.
 * Compatible with Cloudflare Workers runtime.
 *
 * BR-PRIVACY-003: AES-GCM with HKDF-derived key per workspace.
 * BR-PRIVACY-004: pii_key_version enables lazy key rotation.
 * BR-PRIVACY-002: Only hashes are persisted; plaintext is transient.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PiiKeyVersion = number;

/** Result of an encryption operation — includes key version for storage. */
export interface EncryptResult {
  ciphertext: string; // base64url — nonce prepended (12 bytes || ciphertext)
  piiKeyVersion: PiiKeyVersion;
}

export type PiiError =
  | { code: 'decryption_failed'; message: string }
  | { code: 'encryption_failed'; message: string }
  | { code: 'invalid_key_version'; message: string };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HKDF_HASH = 'SHA-256';
const AES_ALGORITHM = 'AES-GCM';
const AES_KEY_LENGTH = 256;
const NONCE_BYTES = 12; // 96-bit nonce for AES-GCM

// ---------------------------------------------------------------------------
// Master key registry
// A real runtime reads from environment bindings; tests inject via factory.
// ---------------------------------------------------------------------------

/** Map of version → hex-encoded master key material (32 bytes = 64 hex chars). */
export type MasterKeyRegistry = Record<number, string>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64url(bytes: Uint8Array): string {
  // btoa works with binary strings
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const padded2 = pad === 0 ? padded : padded + '==='.slice(0, 4 - pad);
  const binary = atob(padded2);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// HKDF key derivation
// BR-PRIVACY-003: derive AES key per workspace from master key via HKDF.
// ---------------------------------------------------------------------------

async function deriveWorkspaceKey(
  masterKeyHex: string,
  workspaceId: string,
): Promise<CryptoKey> {
  const masterKeyBytes = hexToBytes(masterKeyHex);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    masterKeyBytes,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );

  const salt = new TextEncoder().encode(workspaceId);
  const info = new TextEncoder().encode('pii');

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: HKDF_HASH,
      salt,
      info,
    },
    baseKey,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash a PII value with SHA-256 scoped to workspace.
 * Result is a deterministic hex string safe to persist.
 *
 * BR-PRIVACY-002: only hash is persisted — plaintext is transient.
 */
export async function hashPii(
  value: string,
  workspaceId: string,
): Promise<string> {
  // Scoped hash: workspace_id:value prevents cross-workspace correlation
  const input = new TextEncoder().encode(`${workspaceId}:${value}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Encrypt a PII value with AES-256-GCM using a HKDF-derived key per workspace.
 *
 * BR-PRIVACY-003: AES-GCM with HKDF-derived key per workspace.
 * BR-PRIVACY-004: returns piiKeyVersion so caller can persist it.
 *
 * @param value - plaintext PII (email, phone, name)
 * @param workspaceId - workspace scope for HKDF salt
 * @param masterKeyRegistry - version → hex master key (32 bytes)
 * @param currentVersion - which version to use for new encryptions
 */
export async function encryptPii(
  value: string,
  workspaceId: string,
  masterKeyRegistry: MasterKeyRegistry,
  currentVersion: PiiKeyVersion = 1,
): Promise<Result<EncryptResult, PiiError>> {
  // BR-PRIVACY-004: always write with current version
  const masterKeyHex = masterKeyRegistry[currentVersion];
  if (!masterKeyHex) {
    return {
      ok: false,
      error: {
        code: 'invalid_key_version',
        message: `Key version ${currentVersion} not found in registry`,
      },
    };
  }

  try {
    const key = await deriveWorkspaceKey(masterKeyHex, workspaceId);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const plaintext = new TextEncoder().encode(value);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: AES_ALGORITHM, iv: nonce },
      key,
      plaintext,
    );

    // Prepend nonce to ciphertext: [12 bytes nonce || ciphertext bytes]
    const ciphertextBytes = new Uint8Array(ciphertextBuffer);
    const combined = new Uint8Array(NONCE_BYTES + ciphertextBytes.length);
    combined.set(nonce, 0);
    combined.set(ciphertextBytes, NONCE_BYTES);

    return {
      ok: true,
      value: {
        ciphertext: bytesToBase64url(combined),
        piiKeyVersion: currentVersion,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'encryption_failed',
        message: 'AES-GCM encryption error',
      },
    };
  }
}

/**
 * Decrypt a PII ciphertext using the correct versioned key.
 *
 * BR-PRIVACY-003: uses workspace-scoped HKDF key.
 * BR-PRIVACY-004: reads piiKeyVersion from stored row to select correct key.
 *
 * @param ciphertext - base64url-encoded [nonce || ciphertext]
 * @param workspaceId - must match the workspace used during encryption
 * @param masterKeyRegistry - version → hex master key
 * @param piiKeyVersion - key version stored on the row
 */
export async function decryptPii(
  ciphertext: string,
  workspaceId: string,
  masterKeyRegistry: MasterKeyRegistry,
  piiKeyVersion: PiiKeyVersion = 1,
): Promise<Result<string, PiiError>> {
  // BR-PRIVACY-004: read with the version stored on the row
  const masterKeyHex = masterKeyRegistry[piiKeyVersion];
  if (!masterKeyHex) {
    return {
      ok: false,
      error: {
        code: 'invalid_key_version',
        message: `Key version ${piiKeyVersion} not found in registry`,
      },
    };
  }

  try {
    const combined = base64urlToBytes(ciphertext);
    if (combined.length <= NONCE_BYTES) {
      return {
        ok: false,
        error: { code: 'decryption_failed', message: 'Ciphertext too short' },
      };
    }

    const nonce = combined.slice(0, NONCE_BYTES);
    const encrypted = combined.slice(NONCE_BYTES);

    const key = await deriveWorkspaceKey(masterKeyHex, workspaceId);

    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: AES_ALGORITHM, iv: nonce },
      key,
      encrypted,
    );

    return {
      ok: true,
      value: new TextDecoder().decode(plaintextBuffer),
    };
  } catch {
    // BR-PRIVACY-003: wrong workspace or corrupted ciphertext → decryption_failed
    return {
      ok: false,
      error: {
        code: 'decryption_failed',
        message: 'AES-GCM decryption failed',
      },
    };
  }
}
