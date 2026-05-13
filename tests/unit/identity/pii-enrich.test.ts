/**
 * Unit tests — pii-enrich (ADR-044).
 *
 * Verifies the overwrite-on-divergence semantics:
 *   1. First write: ciphertext NULL → encrypt + write.
 *   2. Idempotent: plaintext matches decrypted current → no UPDATE issued.
 *   3. Re-identification: plaintext differs → re-encrypt + UPDATE.
 *   4. Soft-fail: master key missing → returns ok=false, no DB calls.
 *   5. Lead not found → returns ok=false, no UPDATE.
 *   6. Decrypt failure on existing ciphertext → skip overwrite (data preservation).
 *
 * Mock-based: drizzle calls captured, no real SQL. `encryptPii` / `decryptPii`
 * run for real against Node WebCrypto.
 */

import { describe, expect, it, vi } from 'vitest';
import { enrichLeadPii } from '../../../apps/edge/src/lib/pii-enrich';
import { encryptPii } from '../../../apps/edge/src/lib/pii';

const WORKSPACE_ID = '74860330-a528-4951-bf49-90f0b5c72521';
const LEAD_ID = 'lead-00000000-0000-0000-0000-000000000001';
const MASTER_KEY_HEX = 'a'.repeat(64); // 32 bytes hex

type SetCall = Record<string, unknown>;

function makeDb(
  selectRows: Array<{
    emailEnc: string | null;
    phoneEnc: string | null;
    nameEnc: string | null;
    piiKeyVersion: number | null;
  }>,
) {
  const setCalls: SetCall[] = [];
  const whereAfterSet = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockImplementation((vals: SetCall) => {
    setCalls.push(vals);
    return { where: whereAfterSet };
  });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });

  const limitMock = vi.fn().mockResolvedValue(selectRows);
  const whereAfterFrom = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereAfterFrom });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: { select: selectMock, update: updateMock } as unknown as Parameters<
      typeof enrichLeadPii
    >[1]['db'],
    setCalls,
    updateMock,
    selectMock,
  };
}

async function encryptForFixture(plaintext: string): Promise<string> {
  const result = await encryptPii(
    plaintext,
    WORKSPACE_ID,
    { 1: MASTER_KEY_HEX },
    1,
  );
  if (!result.ok) throw new Error('fixture encrypt failed');
  return result.value.ciphertext;
}

describe('enrichLeadPii — ADR-044 overwrite-on-divergence', () => {
  it('first write: encrypts and stores when ciphertexts are NULL', async () => {
    const { db, setCalls, updateMock } = makeDb([
      { emailEnc: null, phoneEnc: null, nameEnc: null, piiKeyVersion: null },
    ]);

    const result = await enrichLeadPii(
      { email: 'foo@bar.com', phone: '+5511999999999', name: 'Foo Bar' },
      {
        leadId: LEAD_ID,
        workspaceId: WORKSPACE_ID,
        db,
        masterKeyHex: MASTER_KEY_HEX,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.updated_columns).toEqual(
      expect.arrayContaining(['emailEnc', 'phoneEnc', 'nameEnc', 'name']),
    );
    expect(updateMock).toHaveBeenCalled();
    const firstSet = setCalls[0] as Record<string, unknown>;
    expect(firstSet).toHaveProperty('emailEnc');
    expect(firstSet).toHaveProperty('phoneEnc');
    expect(firstSet).toHaveProperty('nameEnc');
    expect(firstSet).toHaveProperty('piiKeyVersion', 1);
  });

  it('idempotent: plaintext matches existing ciphertext → no enc UPDATE issued', async () => {
    const existingEmailCt = await encryptForFixture('foo@bar.com');
    const existingPhoneCt = await encryptForFixture('+5511999999999');
    const existingNameCt = await encryptForFixture('Foo Bar');
    const { db, setCalls, updateMock } = makeDb([
      {
        emailEnc: existingEmailCt,
        phoneEnc: existingPhoneCt,
        nameEnc: existingNameCt,
        piiKeyVersion: 1,
      },
    ]);

    const result = await enrichLeadPii(
      { email: 'foo@bar.com', phone: '+5511999999999', name: 'Foo Bar' },
      {
        leadId: LEAD_ID,
        workspaceId: WORKSPACE_ID,
        db,
        masterKeyHex: MASTER_KEY_HEX,
      },
    );

    expect(result.ok).toBe(true);
    // No enc column should appear in updated_columns; name plaintext update
    // is unconditional, so name/fnHash/lnHash may still be in the list.
    expect(result.updated_columns).not.toContain('emailEnc');
    expect(result.updated_columns).not.toContain('phoneEnc');
    expect(result.updated_columns).not.toContain('nameEnc');
    // No piiKeyVersion in any SET payload since no enc was written
    for (const call of setCalls) {
      expect(call).not.toHaveProperty('piiKeyVersion');
    }
    // The unconditional name update still runs (writes leads.name + hashes)
    expect(updateMock).toHaveBeenCalled();
  });

  it('re-identification: plaintext differs → re-encrypt and overwrite emailEnc', async () => {
    const oldEmailCt = await encryptForFixture('old@bar.com');
    const { db, setCalls } = makeDb([
      {
        emailEnc: oldEmailCt,
        phoneEnc: null,
        nameEnc: null,
        piiKeyVersion: 1,
      },
    ]);

    const result = await enrichLeadPii(
      { email: 'new@bar.com' },
      {
        leadId: LEAD_ID,
        workspaceId: WORKSPACE_ID,
        db,
        masterKeyHex: MASTER_KEY_HEX,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.updated_columns).toContain('emailEnc');
    const firstSet = setCalls[0] as Record<string, unknown>;
    expect(firstSet).toHaveProperty('emailEnc');
    expect(firstSet.emailEnc).not.toBe(oldEmailCt); // new ciphertext
    expect(firstSet).toHaveProperty('piiKeyVersion', 1);
  });

  it('soft-fail: no masterKeyHex → ok=false, no DB calls', async () => {
    const { db, updateMock, selectMock } = makeDb([
      { emailEnc: null, phoneEnc: null, nameEnc: null, piiKeyVersion: null },
    ]);

    const result = await enrichLeadPii(
      { email: 'foo@bar.com' },
      { leadId: LEAD_ID, workspaceId: WORKSPACE_ID, db },
    );

    expect(result.ok).toBe(false);
    expect(result.updated_columns).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('lead not found → ok=false, no UPDATE', async () => {
    const { db, updateMock } = makeDb([]); // empty SELECT result

    const result = await enrichLeadPii(
      { email: 'foo@bar.com' },
      {
        leadId: LEAD_ID,
        workspaceId: WORKSPACE_ID,
        db,
        masterKeyHex: MASTER_KEY_HEX,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.updated_columns).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('decrypt failure on existing ciphertext: skip overwrite (data preservation)', async () => {
    // Encrypt with one key, but pii-enrich runs with a different key → decrypt
    // fails. Conservative behavior: do NOT overwrite the ciphertext.
    const otherKey = 'b'.repeat(64);
    const result = await encryptPii(
      'unknown-plaintext',
      WORKSPACE_ID,
      { 1: otherKey },
      1,
    );
    if (!result.ok) throw new Error('fixture encrypt failed');

    const { db, setCalls } = makeDb([
      {
        emailEnc: result.value.ciphertext,
        phoneEnc: null,
        nameEnc: null,
        piiKeyVersion: 1,
      },
    ]);

    const enrichResult = await enrichLeadPii(
      { email: 'new@bar.com' },
      {
        leadId: LEAD_ID,
        workspaceId: WORKSPACE_ID,
        db,
        masterKeyHex: MASTER_KEY_HEX, // different key → decrypt will fail
      },
    );

    expect(enrichResult.ok).toBe(true);
    expect(enrichResult.updated_columns).not.toContain('emailEnc');
    // setCalls should be empty (no enc write, no name update since no name input)
    expect(setCalls).toEqual([]);
  });
});
