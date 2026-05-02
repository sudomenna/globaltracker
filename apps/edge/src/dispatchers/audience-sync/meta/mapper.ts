/**
 * Meta Custom Audiences mapper.
 *
 * Converts an array of MetaMember (email_hash + phone_hash) into the
 * payload shape expected by the Meta Marketing API Custom Audiences endpoint.
 *
 * T-5-005
 *
 * BR-IDENTITY-002: leads.email_hash and phone_hash are already SHA-256
 *   normalized before storage — no re-hashing needed here.
 * BR-PRIVACY-002: we only transmit hashes, never PII in clear.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetaMember {
  /** SHA-256 hex of the normalized email. Null if not available. */
  emailHash: string | null;
  /** SHA-256 hex of the E.164-normalized phone. Null if not available. */
  phoneHash: string | null;
}

export interface MetaAudiencePayload {
  schema: string[];
  data: (string | null)[][];
}

// ---------------------------------------------------------------------------
// buildMetaPayload
// ---------------------------------------------------------------------------

/**
 * Build the payload for Meta's Custom Audiences `/users` endpoint.
 *
 * BR-IDENTITY-002: hashes already normalized — pass through directly.
 *
 * @param members - list of MetaMember objects to include in this batch.
 * @returns payload object with schema + data arrays.
 */
export function buildMetaPayload(members: MetaMember[]): MetaAudiencePayload {
  return {
    schema: ['EMAIL_SHA256_NORMALIZED', 'PHONE_SHA256_NORMALIZED'],
    data: members.map((m) => [m.emailHash, m.phoneHash]),
  };
}
