/**
 * Integration flow tests — FLOW-07: Lead retornante dispara InitiateCheckout
 *
 * Tests exercise issueLeadToken + validateLeadToken using a mocked DB.
 * The real HMAC crypto (Web Crypto API) runs in-process; only the DB layer is mocked.
 *
 * BRs applied:
 *   BR-IDENTITY-005: lead_token HMAC obrigatório com binding a page_token_hash
 *   INV-IDENTITY-006: LeadToken válido apenas com page_token_hash correspondente
 *   BR-PRIVACY-001: falha de validação não deve logar o token em claro
 *
 * Test coverage:
 *   TC-07-01: token válido → {ok: true, value: {lead_id}}
 *   TC-07-02: token expirado → {ok: false, error: {code: 'expired'}}
 *   TC-07-03: token revogado → {ok: false, error: {code: 'revoked'}}
 *   TC-07-04: page_token_hash mismatch → {ok: false, error: {code: 'page_mismatch'}}
 *   TC-07-05: sem token (undefined) → não lança exceção; retorna graciosamente
 */

import { describe, expect, it, vi } from 'vitest';
import {
  issueLeadToken,
  validateLeadToken,
} from '../../../apps/edge/src/lib/lead-token';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LEAD_ID = 'lead-00000000-0000-flow07-0000-aaaaaaaaaaaa';
const WORKSPACE_ID = 'ws-flow07-0000-0000-0000-000000000001';
const PAGE_TOKEN_HASH_H1 = 'h1_'.repeat(20).slice(0, 64); // deterministic 64-char string
const PAGE_TOKEN_HASH_H2 = 'h2_'.repeat(20).slice(0, 64); // different hash

/** 32-byte test HMAC secret — never use in production. */
const HMAC_SECRET = new Uint8Array(32).fill(0xde);

// TTL in days
const TTL_60_DAYS = 60;
const TTL_ZERO_DAYS = 0; // causes immediate expiry

// ---------------------------------------------------------------------------
// DB mock factories
// ---------------------------------------------------------------------------

/**
 * Creates a DB mock for issueLeadToken that returns the token_id after insert.
 */
function makeIssueDb(tokenId = 'token-uuid-001') {
  const inserted: unknown[] = [];
  const returning = vi.fn().mockResolvedValue([{ id: tokenId }]);
  const values = vi.fn().mockImplementation((vals) => {
    inserted.push(vals);
    return { returning };
  });
  const insert = vi.fn().mockReturnValue({ values });

  // update for last_used_at (fire-and-forget in validateLeadToken)
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  });

  return {
    db: { insert, update } as unknown as Parameters<typeof issueLeadToken>[4],
    inserted,
    values,
    returning,
  };
}

/**
 * Creates a DB mock for validateLeadToken.
 * Returns a configurable token row.
 */
function makeValidateDb(
  tokenRow: {
    id: string;
    leadId: string;
    workspaceId: string;
    pageTokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
  } | null,
) {
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  });

  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(tokenRow ? [tokenRow] : []),
      }),
    }),
  });

  return {
    db: { select, update } as unknown as Parameters<
      typeof validateLeadToken
    >[2],
    update,
  };
}

// ---------------------------------------------------------------------------
// Helper: issue a real token and return it + expiry date
// ---------------------------------------------------------------------------

async function issueRealToken(
  ttlDays: number,
  pageTokenHash: string = PAGE_TOKEN_HASH_H1,
): Promise<{ tokenClear: string; expiresAt: Date; tokenId: string }> {
  const { db } = makeIssueDb();
  const result = await issueLeadToken(
    LEAD_ID,
    WORKSPACE_ID,
    pageTokenHash,
    ttlDays,
    db,
    HMAC_SECRET,
  );
  if (!result.ok)
    throw new Error(`issueLeadToken failed: ${result.error.code}`);
  return {
    tokenClear: result.value.token_clear,
    expiresAt: result.value.expires_at,
    tokenId: result.value.token_id,
  };
}

// ---------------------------------------------------------------------------
// TC-07-01: Happy path — lead retornante com __ftk válido
// ---------------------------------------------------------------------------

describe('TC-07-01: token válido — validateLeadToken retorna lead_id', () => {
  it('BR-IDENTITY-005: token emitido e validado com mesmo page_token_hash retorna ok + lead_id', async () => {
    const { tokenClear, expiresAt } = await issueRealToken(TTL_60_DAYS);

    // Simula DB retornando a row do token (como foi persistida)
    const tokenRow = {
      id: 'token-uuid-001',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt, // futuro
      revokedAt: null,
    };

    const { db } = makeValidateDb(tokenRow);

    const result = await validateLeadToken(
      tokenClear,
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_id).toBe(LEAD_ID);
  });

  it('last_used_at é atualizado após validação bem-sucedida', async () => {
    const { tokenClear, expiresAt } = await issueRealToken(TTL_60_DAYS);

    const tokenRow = {
      id: 'token-uuid-001',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt,
      revokedAt: null,
    };

    const { db, update } = makeValidateDb(tokenRow);

    await validateLeadToken(tokenClear, PAGE_TOKEN_HASH_H1, db, HMAC_SECRET);

    // update deve ter sido chamado para last_used_at
    expect(update).toHaveBeenCalled();
    const setArg = (
      update.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> }
    )?.set;
    if (setArg) {
      expect(setArg).toHaveBeenCalledWith(
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// TC-07-02: Token expirado — evento aceito como anônimo
// ---------------------------------------------------------------------------

describe('TC-07-02: token expirado → {ok: false, error: {code: "expired"}}', () => {
  it('token com expires_at no passado retorna code=expired', async () => {
    // Para simular expirado: emitir token e setar expires_at no passado no mock DB
    const { tokenClear } = await issueRealToken(TTL_60_DAYS);

    const expiredTokenRow = {
      id: 'token-expired-001',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt: new Date(Date.now() - 1000), // já expirou
      revokedAt: null,
    };

    const { db } = makeValidateDb(expiredTokenRow);

    const result = await validateLeadToken(
      tokenClear,
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('expired');
  });

  it('token expirado: edge deve tratar evento como anônimo (sem lead_id)', async () => {
    // Validação retorna error=expired; chamador remove lead_id do payload
    const { tokenClear } = await issueRealToken(TTL_60_DAYS);
    const expiredRow = {
      id: 'token-exp-002',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt: new Date(0), // epoch past
      revokedAt: null,
    };

    const { db } = makeValidateDb(expiredRow);
    const result = await validateLeadToken(
      tokenClear,
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    // Comportamento esperado por FLOW-07 A1: erro → evento anônimo
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('expired');
    // A mensagem não deve conter o token em claro (BR-PRIVACY-001)
    expect(result.error.message).not.toContain(tokenClear);
  });
});

// ---------------------------------------------------------------------------
// TC-07-03: Token revogado
// ---------------------------------------------------------------------------

describe('TC-07-03: token revogado → {ok: false, error: {code: "revoked"}}', () => {
  it('token com revoked_at setado retorna code=revoked', async () => {
    const { tokenClear, expiresAt } = await issueRealToken(TTL_60_DAYS);

    const revokedTokenRow = {
      id: 'token-revoked-001',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt,
      revokedAt: new Date(Date.now() - 500), // revogado antes
    };

    const { db } = makeValidateDb(revokedTokenRow);

    const result = await validateLeadToken(
      tokenClear,
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('revoked');
  });

  it('token revogado é verificado ANTES de expirado (revoked tem prioridade)', async () => {
    // revoked_at verificado antes de expires_at na implementação
    const { tokenClear } = await issueRealToken(TTL_60_DAYS);

    const bothRevocedAndExpired = {
      id: 'token-both-001',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt: new Date(Date.now() - 1000), // também expirado
      revokedAt: new Date(Date.now() - 2000), // revogado
    };

    const { db } = makeValidateDb(bothRevocedAndExpired);

    const result = await validateLeadToken(
      tokenClear,
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Implementation checks revoked first
    expect(result.error.code).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// TC-07-04: Page token hash mismatch (INV-IDENTITY-006)
// ---------------------------------------------------------------------------

describe('TC-07-04: page_token_hash mismatch → {ok: false, error: {code: "page_mismatch"}}', () => {
  it('INV-IDENTITY-006: token emitido com H1 e validado com H2 retorna code=page_mismatch', async () => {
    // Token emitido para page H1
    const { tokenClear, expiresAt } = await issueRealToken(
      TTL_60_DAYS,
      PAGE_TOKEN_HASH_H1,
    );

    // DB retorna row com H1 (como foi persistida)
    const tokenRow = {
      id: 'token-uuid-h1',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt,
      revokedAt: null,
    };

    const { db } = makeValidateDb(tokenRow);

    // Validando com H2 (page diferente)
    const result = await validateLeadToken(
      tokenClear,
      PAGE_TOKEN_HASH_H2, // page errada
      db,
      HMAC_SECRET,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('page_mismatch');
  });

  it('INV-IDENTITY-006: token com H1 validado na mesma page H1 não falha com page_mismatch', async () => {
    const { tokenClear, expiresAt } = await issueRealToken(
      TTL_60_DAYS,
      PAGE_TOKEN_HASH_H1,
    );

    const tokenRow = {
      id: 'token-uuid-h1-ok',
      leadId: LEAD_ID,
      workspaceId: WORKSPACE_ID,
      pageTokenHash: PAGE_TOKEN_HASH_H1,
      expiresAt,
      revokedAt: null,
    };

    const { db } = makeValidateDb(tokenRow);

    const result = await validateLeadToken(
      tokenClear,
      PAGE_TOKEN_HASH_H1, // mesma page
      db,
      HMAC_SECRET,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-07-05: Sem token — evento anônimo (middleware não rejeita)
// ---------------------------------------------------------------------------

describe('TC-07-05: sem token (__ftk ausente) — retorna graciosamente sem lead_id', () => {
  it('validateLeadToken com string vazia retorna ok=false mas não lança exceção', async () => {
    // Middleware NÃO rejeita — apenas remove lead_id do payload
    const { db } = makeValidateDb(null);

    // O validateLeadToken recebe string vazia (ausência de cookie)
    const result = await validateLeadToken(
      '',
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    // Deve retornar graciosamente com error estruturado, sem throw
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_token');
  });

  it('validateLeadToken com token malformado não lança exceção', async () => {
    const { db } = makeValidateDb(null);

    // Simula __ftk corrompido ou modificado pelo browser
    const result = await validateLeadToken(
      'definitely.not.a.valid.token',
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    expect(() => result).not.toThrow();
    expect(result.ok).toBe(false);
  });

  it('eventos sem __ftk devem ser tratados como anônimos — sem lead_id no resultado', async () => {
    // FLOW-07 A3: cookie ausente → eventos anônimos, sem lead_id
    const { db } = makeValidateDb(null);

    const result = await validateLeadToken(
      '',
      PAGE_TOKEN_HASH_H1,
      db,
      HMAC_SECRET,
    );

    // result.ok=false significa que o chamador deve usar lead_id=null (evento anônimo)
    expect(result.ok).toBe(false);
    // Não há lead_id no resultado de erro
    if (!result.ok) {
      expect((result as { value?: unknown }).value).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Testes adicionais: issueLeadToken persiste token_hash no DB (não o clear)
// ---------------------------------------------------------------------------

describe('issueLeadToken: token persistido corretamente no DB', () => {
  it('persiste token_hash (SHA-256 hex de 64 chars) e não o token em claro', async () => {
    const { db, inserted } = makeIssueDb();

    const result = await issueLeadToken(
      LEAD_ID,
      WORKSPACE_ID,
      PAGE_TOKEN_HASH_H1,
      TTL_60_DAYS,
      db,
      HMAC_SECRET,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verifica que o token_hash foi persistido (64-char hex = SHA-256)
    const persistedRow = inserted[0] as Record<string, unknown>;
    expect(typeof persistedRow.tokenHash).toBe('string');
    expect((persistedRow.tokenHash as string).length).toBe(64);
    // O token em claro NÃO deve ter sido persistido
    expect(persistedRow.tokenClear).toBeUndefined();
    // page_token_hash deve ter sido persistido
    expect(persistedRow.pageTokenHash).toBe(PAGE_TOKEN_HASH_H1);
  });

  it('expires_at está a TTL_60_DAYS no futuro', async () => {
    const before = new Date();
    const { tokenClear: _, expiresAt } = await issueRealToken(TTL_60_DAYS);
    const after = new Date();

    const expectedMs = 60 * 24 * 60 * 60 * 1000;
    const actualMs = expiresAt.getTime() - before.getTime();
    const maxMs = expiresAt.getTime() - after.getTime();

    // expires_at deve ser ~60d no futuro (tolerância de 1s)
    expect(actualMs).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(maxMs).toBeLessThanOrEqual(expectedMs);
  });
});
