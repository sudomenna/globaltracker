/**
 * Integration tests — Identity schema constraints
 *
 * Validates:
 *   INV-IDENTITY-001 — active aliases are unique per (workspace_id, identifier_type, identifier_hash)
 *                       via partial unique index uq_lead_aliases_active_per_identifier WHERE status='active'
 *   INV-IDENTITY-002 — nullable PII columns: email_enc, phone_enc, name_enc, email_hash, phone_hash
 *                       can be NULL (schema allows it; erased leads use this)
 *   lead_tokens: token_hash is globally unique (uq_lead_tokens_token_hash)
 *   lead_tokens: token_hash and page_token_hash must be exactly 64 chars (SHA-256 hex)
 *   leads: status must be in ('active', 'merged', 'erased') — chk_leads_status
 *   lead_aliases: identifier_type must be canonical — chk_lead_aliases_identifier_type
 *   lead_merges: reason must be canonical — chk_lead_merges_reason
 *   lead_consents: consent_* values must be canonical — chk_lead_consents_consent_*
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations 0000, 0001, and 0004 applied.
 *
 * Pattern: each test uses a transaction rolled back after the assertion,
 * keeping the DB clean between tests.
 *
 * BR-IDENTITY-001: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
 * BR-PRIVACY-002: *_hash columns hold SHA-256 hex; may be NULL before assignment
 * BR-PRIVACY-003: *_enc columns hold AES-256-GCM base64; may be NULL before assignment / after SAR
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

// Helper: generate a valid SHA-256 hex string (64 chars)
const sha256Hex = (prefix: string): string =>
  prefix.padEnd(64, '0').slice(0, 64);

describeIfDb('identity constraints', () => {
  let sql: ReturnType<typeof postgres>;

  // Reusable workspace UUID inserted once per suite
  const workspaceId = '10000000-0000-0000-0000-000000000001';
  const workspaceSlug = `identity-test-${Date.now()}`;

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });

    // Create the test workspace (outside any rollback transaction so all tests see it)
    await sql`SET LOCAL app.current_workspace_id = ${workspaceId}`;
    await sql`
      INSERT INTO workspaces (id, slug, name, status)
      VALUES (${workspaceId}::uuid, ${workspaceSlug}, 'Identity Test WS', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    // Clean up the test workspace and all cascading rows
    await sql`DELETE FROM lead_tokens    WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM lead_consents  WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM lead_merges    WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM lead_aliases   WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM leads          WHERE workspace_id = ${workspaceId}::uuid`;
    await sql`DELETE FROM workspaces     WHERE id           = ${workspaceId}::uuid`;
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // Helper: insert a lead and return its id
  // ---------------------------------------------------------------------------
  async function insertLead(
    tx: ReturnType<typeof postgres>,
    opts: { emailHash?: string; status?: string } = {},
  ): Promise<string> {
    await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
    const rows = await tx`
      INSERT INTO leads (workspace_id, email_hash, status)
      VALUES (
        ${workspaceId}::uuid,
        ${opts.emailHash ?? null},
        ${opts.status ?? 'active'}
      )
      RETURNING id
    `;
    // biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess
    return rows[0]['id'] as string;
  }

  // ---------------------------------------------------------------------------
  // INV-IDENTITY-001 / BR-IDENTITY-001:
  // Two active aliases with the same (workspace_id, identifier_type, identifier_hash) must fail
  // ---------------------------------------------------------------------------
  it('INV-IDENTITY-001: inserting duplicate active alias fails with unique constraint violation', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        const emailHash = sha256Hex('email-dup-test');
        const leadId1 = await insertLead(tx, { emailHash });
        const leadId2 = await insertLead(tx, { emailHash });

        // First alias — must succeed
        // BR-IDENTITY-001: first active alias for this identifier is valid
        await tx`
          INSERT INTO lead_aliases (workspace_id, identifier_type, identifier_hash, lead_id, source, status)
          VALUES (
            ${workspaceId}::uuid,
            'email_hash',
            ${emailHash},
            ${leadId1}::uuid,
            'form_submit',
            'active'
          )
        `;

        // Second alias with same (workspace_id, identifier_type, identifier_hash) and status='active'
        // INV-IDENTITY-001: must fail — uq_lead_aliases_active_per_identifier
        await expect(
          tx`
            INSERT INTO lead_aliases (workspace_id, identifier_type, identifier_hash, lead_id, source, status)
            VALUES (
              ${workspaceId}::uuid,
              'email_hash',
              ${emailHash},
              ${leadId2}::uuid,
              'form_submit',
              'active'
            )
          `,
        ).rejects.toThrow(/uq_lead_aliases_active_per_identifier/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-IDENTITY-001: superseded alias with same identifier does NOT conflict (partial index only covers active)', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        const emailHash = sha256Hex('email-superseded-test');
        const leadId1 = await insertLead(tx, { emailHash });
        const leadId2 = await insertLead(tx, { emailHash });

        // First alias — active
        await tx`
          INSERT INTO lead_aliases (workspace_id, identifier_type, identifier_hash, lead_id, source, status)
          VALUES (
            ${workspaceId}::uuid,
            'email_hash',
            ${emailHash},
            ${leadId1}::uuid,
            'form_submit',
            'superseded'
          )
        `;

        // Second alias — also superseded with same hash — must succeed (not covered by partial index)
        await expect(
          tx`
            INSERT INTO lead_aliases (workspace_id, identifier_type, identifier_hash, lead_id, source, status)
            VALUES (
              ${workspaceId}::uuid,
              'email_hash',
              ${emailHash},
              ${leadId2}::uuid,
              'merge',
              'superseded'
            )
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // INV-IDENTITY-002: PII columns are nullable — schema allows NULL
  // This validates that the schema correctly permits NULL for all PII fields
  // (erased leads set all PII to NULL via SAR service layer)
  // BR-PRIVACY-002: *_hash nullable; BR-PRIVACY-003: *_enc nullable
  // ---------------------------------------------------------------------------
  it('INV-IDENTITY-002: lead with all PII fields NULL is accepted by schema', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        // All PII fields NULL — valid for erased leads
        await expect(
          tx`
            INSERT INTO leads (
              workspace_id,
              external_id_hash, email_hash, phone_hash, name_hash,
              email_enc, phone_enc, name_enc,
              pii_key_version, status
            )
            VALUES (
              ${workspaceId}::uuid,
              NULL, NULL, NULL, NULL,
              NULL, NULL, NULL,
              1, 'erased'
            )
            RETURNING id
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-IDENTITY-002: lead with partial PII (email_hash only) is accepted by schema', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        const emailHash = sha256Hex('partial-pii-test');

        // Only email_hash set — phone_hash, name_hash, all enc fields NULL
        await expect(
          tx`
            INSERT INTO leads (
              workspace_id,
              email_hash,
              pii_key_version, status
            )
            VALUES (
              ${workspaceId}::uuid,
              ${emailHash},
              1, 'active'
            )
            RETURNING id
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // ADR-005: leads.email_hash does NOT have a unique constraint
  // Multiple leads can share the same email_hash (pre-merge state)
  // ---------------------------------------------------------------------------
  it('ADR-005: two active leads with the same email_hash are accepted (no unique constraint on leads.email_hash)', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        const emailHash = sha256Hex('shared-email-hash-test');

        // First lead with this email_hash
        await tx`
          INSERT INTO leads (workspace_id, email_hash, status)
          VALUES (${workspaceId}::uuid, ${emailHash}, 'active')
        `;

        // Second lead with same email_hash — must succeed (ADR-005: no unique on leads.email_hash)
        await expect(
          tx`
            INSERT INTO leads (workspace_id, email_hash, status)
            VALUES (${workspaceId}::uuid, ${emailHash}, 'active')
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // leads: chk_leads_status — invalid status values are rejected
  // ---------------------------------------------------------------------------
  it('leads: invalid status value fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await expect(
          tx`
            INSERT INTO leads (workspace_id, status)
            VALUES (${workspaceId}::uuid, 'deleted')
          `,
        ).rejects.toThrow(/chk_leads_status/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // lead_aliases: chk_lead_aliases_identifier_type — invalid type rejected
  // ---------------------------------------------------------------------------
  it('lead_aliases: invalid identifier_type fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_aliases (workspace_id, identifier_type, identifier_hash, lead_id, source, status)
            VALUES (
              ${workspaceId}::uuid,
              'ip_address',
              ${sha256Hex('ip-test')},
              ${leadId}::uuid,
              'form_submit',
              'active'
            )
          `,
        ).rejects.toThrow(/chk_lead_aliases_identifier_type/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // lead_aliases: chk_lead_aliases_source — invalid source rejected
  // ---------------------------------------------------------------------------
  it('lead_aliases: invalid source fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_aliases (workspace_id, identifier_type, identifier_hash, lead_id, source, status)
            VALUES (
              ${workspaceId}::uuid,
              'email_hash',
              ${sha256Hex('source-test')},
              ${leadId}::uuid,
              'unknown_source',
              'active'
            )
          `,
        ).rejects.toThrow(/chk_lead_aliases_source/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // lead_merges: chk_lead_merges_reason — invalid reason rejected
  // ---------------------------------------------------------------------------
  it('lead_merges: invalid reason fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const canonicalId = await insertLead(tx);
        const mergedId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_merges (workspace_id, canonical_lead_id, merged_lead_id, reason, performed_by)
            VALUES (
              ${workspaceId}::uuid,
              ${canonicalId}::uuid,
              ${mergedId}::uuid,
              'duplicate',
              'system'
            )
          `,
        ).rejects.toThrow(/chk_lead_merges_reason/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // lead_consents: chk_lead_consents_consent_analytics — invalid value rejected
  // ---------------------------------------------------------------------------
  it('lead_consents: invalid consent_analytics value fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_consents (
              workspace_id, lead_id,
              consent_analytics, consent_marketing, consent_ad_user_data,
              consent_ad_personalization, consent_customer_match,
              source, policy_version
            )
            VALUES (
              ${workspaceId}::uuid, ${leadId}::uuid,
              'maybe', 'unknown', 'unknown',
              'unknown', 'unknown',
              'tracker', '1.0'
            )
          `,
        ).rejects.toThrow(/chk_lead_consents_consent_analytics/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('lead_consents: all consent values set to granted is accepted', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_consents (
              workspace_id, lead_id,
              consent_analytics, consent_marketing, consent_ad_user_data,
              consent_ad_personalization, consent_customer_match,
              source, policy_version
            )
            VALUES (
              ${workspaceId}::uuid, ${leadId}::uuid,
              'granted', 'granted', 'granted',
              'granted', 'granted',
              'tracker', '2024-01'
            )
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // lead_tokens: uq_lead_tokens_token_hash — globally unique token_hash
  // ---------------------------------------------------------------------------
  it('lead_tokens: duplicate token_hash globally fails unique constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId1 = await insertLead(tx);
        const leadId2 = await insertLead(tx);
        const tokenHash = sha256Hex('token-dup-test');
        const pageTokenHash = sha256Hex('page-token-test');

        // First token — must succeed
        await tx`
          INSERT INTO lead_tokens (workspace_id, lead_id, token_hash, page_token_hash, expires_at)
          VALUES (
            ${workspaceId}::uuid, ${leadId1}::uuid,
            ${tokenHash}, ${pageTokenHash},
            now() + interval '30 days'
          )
        `;

        // Same token_hash for a different lead — must fail (uq_lead_tokens_token_hash)
        await expect(
          tx`
            INSERT INTO lead_tokens (workspace_id, lead_id, token_hash, page_token_hash, expires_at)
            VALUES (
              ${workspaceId}::uuid, ${leadId2}::uuid,
              ${tokenHash}, ${pageTokenHash},
              now() + interval '30 days'
            )
          `,
        ).rejects.toThrow(/uq_lead_tokens_token_hash/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('lead_tokens: token_hash shorter than 64 chars fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_tokens (workspace_id, lead_id, token_hash, page_token_hash, expires_at)
            VALUES (
              ${workspaceId}::uuid, ${leadId}::uuid,
              'tooshort',
              ${sha256Hex('valid-page-token')},
              now() + interval '30 days'
            )
          `,
        ).rejects.toThrow(/chk_lead_tokens_token_hash_length/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('lead_tokens: page_token_hash shorter than 64 chars fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_tokens (workspace_id, lead_id, token_hash, page_token_hash, expires_at)
            VALUES (
              ${workspaceId}::uuid, ${leadId}::uuid,
              ${sha256Hex('valid-token')},
              'tooshort',
              now() + interval '30 days'
            )
          `,
        ).rejects.toThrow(/chk_lead_tokens_page_token_hash_length/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('lead_tokens: valid token with 64-char hashes is accepted', async () => {
    await sql
      .begin(async (tx) => {
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
        const leadId = await insertLead(tx);

        await expect(
          tx`
            INSERT INTO lead_tokens (workspace_id, lead_id, token_hash, page_token_hash, expires_at)
            VALUES (
              ${workspaceId}::uuid, ${leadId}::uuid,
              ${sha256Hex('valid-token-full')},
              ${sha256Hex('valid-page-token-full')},
              now() + interval '30 days'
            )
            RETURNING id
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
