/**
 * Unit tests for apps/edge/src/lib/pii.ts
 *
 * Covers:
 *   BR-PRIVACY-002: Only hashes persisted, plaintext transient
 *   BR-PRIVACY-003: AES-256-GCM with HKDF key derivation per workspace
 *   BR-PRIVACY-004: pii_key_version enables lazy rotation (decrypt old, encrypt new)
 */

import { describe, expect, it } from 'vitest';
import {
  type MasterKeyRegistry,
  decryptPii,
  encryptPii,
  hashPii,
} from '../../../apps/edge/src/lib/pii';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 32 bytes of hex (256-bit key) — used only in tests. */
const MASTER_KEY_V1_HEX = 'a'.repeat(64); // 64 hex chars = 32 bytes
const MASTER_KEY_V2_HEX = 'b'.repeat(64);

const REGISTRY_V1: MasterKeyRegistry = { 1: MASTER_KEY_V1_HEX };
const REGISTRY_V2: MasterKeyRegistry = {
  1: MASTER_KEY_V1_HEX,
  2: MASTER_KEY_V2_HEX,
};

const WORKSPACE_A = 'ws_aaaaaa';
const WORKSPACE_B = 'ws_bbbbbb';
const EMAIL = 'foo@bar.com';
const PHONE = '+5511999990000';

// ---------------------------------------------------------------------------
// hashPii
// ---------------------------------------------------------------------------

describe('hashPii', () => {
  it('returns a 64-char hex string (SHA-256)', async () => {
    const hash = await hashPii(EMAIL, WORKSPACE_A);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input always produces same hash', async () => {
    const h1 = await hashPii(EMAIL, WORKSPACE_A);
    const h2 = await hashPii(EMAIL, WORKSPACE_A);
    expect(h1).toBe(h2);
  });

  it('BR-PRIVACY-002: different workspaces produce different hashes for same value', async () => {
    // Cross-workspace correlation is prevented by scoping the hash
    const hA = await hashPii(EMAIL, WORKSPACE_A);
    const hB = await hashPii(EMAIL, WORKSPACE_B);
    expect(hA).not.toBe(hB);
  });

  it('different values produce different hashes', async () => {
    const h1 = await hashPii(EMAIL, WORKSPACE_A);
    const h2 = await hashPii(PHONE, WORKSPACE_A);
    expect(h1).not.toBe(h2);
  });

  it('empty string hashes consistently', async () => {
    const h = await hashPii('', WORKSPACE_A);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// encryptPii
// ---------------------------------------------------------------------------

describe('encryptPii', () => {
  it('BR-PRIVACY-003: returns ok result with ciphertext and piiKeyVersion', async () => {
    const result = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ciphertext).toBeTruthy();
    expect(result.value.piiKeyVersion).toBe(1);
  });

  it('BR-PRIVACY-004: uses currentVersion for encryption', async () => {
    const result = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V2, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.piiKeyVersion).toBe(2);
  });

  it('produces different ciphertext each call (random nonce)', async () => {
    const r1 = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 1);
    const r2 = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 1);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Same plaintext, random nonce → different ciphertext
    expect(r1.value.ciphertext).not.toBe(r2.value.ciphertext);
  });

  it('returns invalid_key_version error when version not in registry', async () => {
    const result = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 99);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_key_version');
  });

  it('encrypts empty string without error', async () => {
    const result = await encryptPii('', WORKSPACE_A, REGISTRY_V1, 1);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decryptPii
// ---------------------------------------------------------------------------

describe('decryptPii', () => {
  it('BR-PRIVACY-003: round-trip encrypt/decrypt returns original plaintext', async () => {
    const enc = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 1);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const dec = await decryptPii(
      enc.value.ciphertext,
      WORKSPACE_A,
      REGISTRY_V1,
      1,
    );
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.value).toBe(EMAIL);
  });

  it('BR-PRIVACY-003: wrong workspace fails to decrypt', async () => {
    // Key derived for WORKSPACE_A cannot decrypt ciphertext from WORKSPACE_B
    const enc = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 1);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const dec = await decryptPii(
      enc.value.ciphertext,
      WORKSPACE_B,
      REGISTRY_V1,
      1,
    );
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.error.code).toBe('decryption_failed');
  });

  it('BR-PRIVACY-004: can decrypt with old key version (v1) even when current is v2', async () => {
    // Simulate: data was encrypted with v1, current version is now v2
    const enc = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 1);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    // Registry has both versions; decrypt with v1
    const dec = await decryptPii(
      enc.value.ciphertext,
      WORKSPACE_A,
      REGISTRY_V2,
      1,
    );
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.value).toBe(EMAIL);
  });

  it('BR-PRIVACY-004: new encryption uses v2; decrypts correctly', async () => {
    const enc = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V2, 2);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.value.piiKeyVersion).toBe(2);

    const dec = await decryptPii(
      enc.value.ciphertext,
      WORKSPACE_A,
      REGISTRY_V2,
      2,
    );
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.value).toBe(EMAIL);
  });

  it('BR-PRIVACY-004: v2-encrypted ciphertext fails with v1 key', async () => {
    const enc = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V2, 2);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    // Attempt to decrypt v2 ciphertext with v1 key — must fail
    const dec = await decryptPii(
      enc.value.ciphertext,
      WORKSPACE_A,
      REGISTRY_V1,
      1,
    );
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.error.code).toBe('decryption_failed');
  });

  it('returns invalid_key_version when version not in registry', async () => {
    const enc = await encryptPii(EMAIL, WORKSPACE_A, REGISTRY_V1, 1);
    if (!enc.ok) return;

    const dec = await decryptPii(enc.value.ciphertext, WORKSPACE_A, {}, 1);
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.error.code).toBe('invalid_key_version');
  });

  it('returns decryption_failed for corrupted ciphertext', async () => {
    const dec = await decryptPii(
      'not_valid_base64url!!',
      WORKSPACE_A,
      REGISTRY_V1,
      1,
    );
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.error.code).toBe('decryption_failed');
  });

  it('returns decryption_failed for truncated ciphertext (too short)', async () => {
    // base64url of a 5-byte buffer (less than NONCE_BYTES=12)
    const tooShort = btoa('short')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const dec = await decryptPii(tooShort, WORKSPACE_A, REGISTRY_V1, 1);
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.error.code).toBe('decryption_failed');
  });

  it('decrypts phone number round-trip', async () => {
    const enc = await encryptPii(PHONE, WORKSPACE_A, REGISTRY_V1, 1);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const dec = await decryptPii(
      enc.value.ciphertext,
      WORKSPACE_A,
      REGISTRY_V1,
      1,
    );
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.value).toBe(PHONE);
  });
});
