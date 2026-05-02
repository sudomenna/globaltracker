/**
 * Integration flow tests — FLOW-08: Merge de leads convergentes
 *
 * Tests exercise resolveLeadByAliases merge logic with a mocked DB.
 * The real hash/crypto runs in-process; only the DB layer is mocked.
 *
 * BRs applied:
 *   BR-IDENTITY-001: aliases ativos únicos por (workspace_id, identifier_type, identifier_hash)
 *   BR-IDENTITY-002: normalize before hash
 *   BR-IDENTITY-003: convergência → merge canônico (mais antigo por first_seen_at wins)
 *   BR-IDENTITY-004: lead merged não recebe novos aliases ou eventos
 *   INV-IDENTITY-001: partial unique index em lead_aliases (status='active')
 *   INV-IDENTITY-003: resolver redireciona merged → canonical transitivamente
 *
 * Test coverage:
 *   TC-08-01: A (email) + B (phone) → merge para A (mais antigo)
 *   TC-08-02: Convergência tripla (3 leads → todos para o mais antigo)
 *   TC-08-03: Stages duplicados → merge não cria duplicate (unique parcial respeitado)
 *   TC-08-04: Idempotência do merge — re-processar com mesmo input não duplica lead_merges
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// Module-level mocks (needed for pii hashing)
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  leadAliases: {},
  leadMerges: {},
  leads: {},
  events: {},
  leadStages: {},
  rawEvents: {},
  leadAttributions: {},
  leadTokens: {},
}));

vi.mock('../../../apps/edge/src/lib/pii', () => ({
  hashPii: vi
    .fn()
    .mockImplementation(
      async (value: string, wsId: string) =>
        `hash-${wsId.slice(-4)}-${value.slice(0, 6)}`,
    ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-flow08-0000-0000-0000-000000000001';

// Lead A: older (canonical candidate)
const LEAD_A_ID = 'lead-flow08-0000-0000-0000-aaaaaaaaaaaa';
const LEAD_A_FIRST_SEEN = new Date('2024-01-01T00:00:00Z');

// Lead B: newer (will be merged into A)
const LEAD_B_ID = 'lead-flow08-0000-0000-0000-bbbbbbbbbbbb';
const LEAD_B_FIRST_SEEN = new Date('2024-03-01T00:00:00Z');

// Lead C: newest (used for triple-convergence test)
const LEAD_C_ID = 'lead-flow08-0000-0000-0000-cccccccccccc';
const LEAD_C_FIRST_SEEN = new Date('2024-05-01T00:00:00Z');

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates a thenable where() result for Drizzle chain mocks.
 * Supports: .then() (await), .limit(), .orderBy().limit()
 */
function makeThenableWhere(resolvedValue: unknown[]) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: mock must be both awaitable and chainable
    then: (onfulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolvedValue).then(onfulfilled),
    limit: vi.fn().mockResolvedValue(resolvedValue),
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(resolvedValue),
    }),
  };
}

/**
 * Flattens insert values: handles both single object and array of objects.
 * Returns an array of the inserted values regardless of how they were passed.
 */
function flattenInsertedRows(
  insertedRows: Array<{ values: unknown }>,
): Array<Record<string, unknown>> {
  const flat: Array<Record<string, unknown>> = [];
  for (const row of insertedRows) {
    const v = row.values;
    if (Array.isArray(v)) {
      for (const item of v) flat.push(item as Record<string, unknown>);
    } else {
      flat.push(v as Record<string, unknown>);
    }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// TC-08-01: Convergência simples A (email) + B (phone) → merge para A
// ---------------------------------------------------------------------------

/**
 * Select call sequence for A+B merge:
 *   1. Find active aliases → [A's email_hash, B's phone_hash]
 *   2. resolveCanonical(A) → status='active'
 *   3. resolveCanonical(B) → status='active'
 *   4. mergeLeads: fetch lead rows [A, B]
 *   5. mergeLeads: active aliases of B (secondary) → [phone_hash]
 *   6. mergeLeads: existing active aliases of A (canonical) → [email_hash]
 *   7. updateExistingLead (end): existing aliases of A → [email_hash, phone_hash]
 */
function makeMergeDb_AandB() {
  const insertedRows: Array<{ values: unknown }> = [];
  const updatedRows: Array<{ set: unknown }> = [];

  let selectCallIdx = 0;

  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCallIdx++;
      const idx = selectCallIdx;

      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            makeThenableWhere(
              idx === 1
                ? [
                    {
                      id: 'alias-A-email',
                      leadId: LEAD_A_ID,
                      identifierType: 'email_hash',
                      identifierHash: 'hash-email',
                    },
                    {
                      id: 'alias-B-phone',
                      leadId: LEAD_B_ID,
                      identifierType: 'phone_hash',
                      identifierHash: 'hash-phone',
                    },
                  ]
                : idx === 2
                  ? [{ status: 'active', mergedIntoLeadId: null }]
                  : idx === 3
                    ? [{ status: 'active', mergedIntoLeadId: null }]
                    : idx === 4
                      ? [
                          {
                            id: LEAD_A_ID,
                            firstSeenAt: LEAD_A_FIRST_SEEN,
                            status: 'active',
                            workspaceId: WORKSPACE_ID,
                          },
                          {
                            id: LEAD_B_ID,
                            firstSeenAt: LEAD_B_FIRST_SEEN,
                            status: 'active',
                            workspaceId: WORKSPACE_ID,
                          },
                        ]
                      : idx === 5
                        ? [
                            {
                              id: 'alias-B-phone',
                              identifierType: 'phone_hash',
                              identifierHash: 'hash-phone',
                            },
                          ]
                        : idx === 6
                          ? [
                              {
                                identifierType: 'email_hash',
                                identifierHash: 'hash-email',
                              },
                            ]
                          : [
                              {
                                identifierType: 'email_hash',
                                identifierHash: 'hash-email',
                              },
                              {
                                identifierType: 'phone_hash',
                                identifierHash: 'hash-phone',
                              },
                            ],
            ),
          ),
        }),
      };
    }),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((setValues: unknown) => ({
        where: vi.fn().mockImplementation(() => {
          updatedRows.push({ set: setValues });
          return Promise.resolve([]);
        }),
      })),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        insertedRows.push({ values: vals });
        return Promise.resolve([]);
      }),
    })),
  } as unknown as Parameters<typeof resolveLeadByAliases>[2];

  return { db, insertedRows, updatedRows };
}

describe('TC-08-01: convergência simples A (email) + B (phone) → merge para A', () => {
  it('BR-IDENTITY-003: canonical = lead mais antigo por first_seen_at', async () => {
    const { db } = makeMergeDb_AandB();

    const result = await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // BR-IDENTITY-003: A é canonical (first_seen_at mais antigo)
    expect(result.value.lead_id).toBe(LEAD_A_ID);
    expect(result.value.merge_executed).toBe(true);
    expect(result.value.was_created).toBe(false);
    expect(result.value.merged_lead_ids).toContain(LEAD_B_ID);
    expect(result.value.merged_lead_ids).toHaveLength(1);
  });

  it('lead B tem status=merged e merged_into_lead_id=A após merge', async () => {
    const { db, updatedRows } = makeMergeDb_AandB();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    // INV-IDENTITY-003: lead B deve ser marcado 'merged' com merged_into_lead_id=A
    const mergeUpdate = updatedRows.find((r) => {
      const s = r.set as Record<string, unknown>;
      return s && s.status === 'merged' && s.mergedIntoLeadId === LEAD_A_ID;
    });
    expect(mergeUpdate).toBeDefined();
  });

  it('lead_merges row criada com canonical=A, merged=B, reason=email_phone_convergence, performedBy=system', async () => {
    const { db, insertedRows } = makeMergeDb_AandB();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    // BR-IDENTITY-003: lead_merges deve ser registrado
    const flatRows = flattenInsertedRows(insertedRows);
    const mergeRow = flatRows.find((v) => 'canonicalLeadId' in v);
    expect(mergeRow).toBeDefined();
    if (!mergeRow) return;
    expect(mergeRow.canonicalLeadId).toBe(LEAD_A_ID);
    expect(mergeRow.mergedLeadId).toBe(LEAD_B_ID);
    expect(mergeRow.reason).toBe('email_phone_convergence');
    expect(mergeRow.performedBy).toBe('system');
  });

  it('aliases de B marcados superseded, e novos aliases source=merge para A inseridos', async () => {
    const { db, updatedRows, insertedRows } = makeMergeDb_AandB();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    // INV-IDENTITY-001: aliases originais de B marcados 'superseded'
    const supersededUpdate = updatedRows.find((r) => {
      const s = r.set as Record<string, unknown>;
      return s && s.status === 'superseded';
    });
    expect(supersededUpdate).toBeDefined();

    // Novos aliases active com source='merge' devem ter leadId=A
    const flatRows = flattenInsertedRows(insertedRows);
    const movedAlias = flatRows.find(
      (v) =>
        v.leadId === LEAD_A_ID && v.status === 'active' && v.source === 'merge',
    );
    expect(movedAlias).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TC-08-02: Convergência tripla — 3 leads → todos para o mais antigo
// ---------------------------------------------------------------------------

/**
 * Select call sequence for A+B+C merge:
 *   1. Find aliases → 3 aliases (A email, B phone, C external_id)
 *   2. resolveCanonical(A) → active
 *   3. resolveCanonical(B) → active
 *   4. resolveCanonical(C) → active
 *   5. mergeLeads: fetch lead rows [A, B, C]
 *   --- merge B into A ---
 *   6. active aliases of B → [phone_hash]
 *   7. existing active aliases of A → [email_hash]
 *   --- merge C into A ---
 *   8. active aliases of C → [external_id_hash]
 *   9. existing active aliases of A → [email_hash, phone_hash]
 *   10. updateExistingLead: existing aliases of A → [all three]
 */
function makeMergeDb_triple() {
  const insertedRows: Array<{ values: unknown }> = [];
  const updatedRows: Array<{ set: unknown }> = [];

  let selectCallIdx = 0;

  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCallIdx++;
      const idx = selectCallIdx;

      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            makeThenableWhere(
              idx === 1
                ? [
                    {
                      id: 'alias-A-email',
                      leadId: LEAD_A_ID,
                      identifierType: 'email_hash',
                      identifierHash: 'hash-email',
                    },
                    {
                      id: 'alias-B-phone',
                      leadId: LEAD_B_ID,
                      identifierType: 'phone_hash',
                      identifierHash: 'hash-phone',
                    },
                    {
                      id: 'alias-C-ext',
                      leadId: LEAD_C_ID,
                      identifierType: 'external_id_hash',
                      identifierHash: 'hash-ext',
                    },
                  ]
                : idx === 2
                  ? [{ status: 'active', mergedIntoLeadId: null }]
                  : idx === 3
                    ? [{ status: 'active', mergedIntoLeadId: null }]
                    : idx === 4
                      ? [{ status: 'active', mergedIntoLeadId: null }]
                      : idx === 5
                        ? [
                            {
                              id: LEAD_A_ID,
                              firstSeenAt: LEAD_A_FIRST_SEEN,
                              status: 'active',
                              workspaceId: WORKSPACE_ID,
                            },
                            {
                              id: LEAD_B_ID,
                              firstSeenAt: LEAD_B_FIRST_SEEN,
                              status: 'active',
                              workspaceId: WORKSPACE_ID,
                            },
                            {
                              id: LEAD_C_ID,
                              firstSeenAt: LEAD_C_FIRST_SEEN,
                              status: 'active',
                              workspaceId: WORKSPACE_ID,
                            },
                          ]
                        : idx === 6
                          ? [
                              {
                                id: 'alias-B-phone',
                                identifierType: 'phone_hash',
                                identifierHash: 'hash-phone',
                              },
                            ]
                          : idx === 7
                            ? [
                                {
                                  identifierType: 'email_hash',
                                  identifierHash: 'hash-email',
                                },
                              ]
                            : idx === 8
                              ? [
                                  {
                                    id: 'alias-C-ext',
                                    identifierType: 'external_id_hash',
                                    identifierHash: 'hash-ext',
                                  },
                                ]
                              : idx === 9
                                ? [
                                    {
                                      identifierType: 'email_hash',
                                      identifierHash: 'hash-email',
                                    },
                                    {
                                      identifierType: 'phone_hash',
                                      identifierHash: 'hash-phone',
                                    },
                                  ]
                                : [
                                    {
                                      identifierType: 'email_hash',
                                      identifierHash: 'hash-email',
                                    },
                                    {
                                      identifierType: 'phone_hash',
                                      identifierHash: 'hash-phone',
                                    },
                                    {
                                      identifierType: 'external_id_hash',
                                      identifierHash: 'hash-ext',
                                    },
                                  ],
            ),
          ),
        }),
      };
    }),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((setValues: unknown) => ({
        where: vi.fn().mockImplementation(() => {
          updatedRows.push({ set: setValues });
          return Promise.resolve([]);
        }),
      })),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        insertedRows.push({ values: vals });
        return Promise.resolve([]);
      }),
    })),
  } as unknown as Parameters<typeof resolveLeadByAliases>[2];

  return { db, insertedRows, updatedRows };
}

describe('TC-08-02: convergência tripla — 3 leads → todos para o mais antigo', () => {
  it('BR-IDENTITY-003: com 3 leads, canonical = A (mais antigo)', async () => {
    const { db } = makeMergeDb_triple();

    const result = await resolveLeadByAliases(
      {
        email: 'foo@example.com',
        phone: '+5511999999999',
        external_id: 'ext-abc',
      },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_id).toBe(LEAD_A_ID);
    expect(result.value.merge_executed).toBe(true);
    expect(result.value.merged_lead_ids).toHaveLength(2);
    expect(result.value.merged_lead_ids).toContain(LEAD_B_ID);
    expect(result.value.merged_lead_ids).toContain(LEAD_C_ID);
  });

  it('B e C têm status=merged após convergência tripla', async () => {
    const { db, updatedRows } = makeMergeDb_triple();

    await resolveLeadByAliases(
      {
        email: 'foo@example.com',
        phone: '+5511999999999',
        external_id: 'ext-abc',
      },
      WORKSPACE_ID,
      db,
    );

    const mergeUpdates = updatedRows.filter((r) => {
      const s = r.set as Record<string, unknown>;
      return s && s.status === 'merged';
    });
    // Deve haver 2 updates de merge (B e C)
    expect(mergeUpdates).toHaveLength(2);
    const mergedIntoIds = mergeUpdates.map(
      (r) => (r.set as Record<string, unknown>).mergedIntoLeadId,
    );
    expect(mergedIntoIds).toEqual(
      expect.arrayContaining([LEAD_A_ID, LEAD_A_ID]),
    );
  });

  it('2 rows em lead_merges (um por lead secundário)', async () => {
    const { db, insertedRows } = makeMergeDb_triple();

    await resolveLeadByAliases(
      {
        email: 'foo@example.com',
        phone: '+5511999999999',
        external_id: 'ext-abc',
      },
      WORKSPACE_ID,
      db,
    );

    const flatRows = flattenInsertedRows(insertedRows);
    const mergeRows = flatRows.filter((v) => 'canonicalLeadId' in v);
    // Dois merges: B→A e C→A
    expect(mergeRows).toHaveLength(2);
    for (const v of mergeRows) {
      expect(v.canonicalLeadId).toBe(LEAD_A_ID);
      expect(v.performedBy).toBe('system');
    }
  });
});

// ---------------------------------------------------------------------------
// TC-08-03: Alias já exists no canonical — merge não cria duplicata
// ---------------------------------------------------------------------------

/**
 * Simula cenário onde B tem um alias (phone_hash) que A já tem também (por algum bug/race).
 * O merge deve silenciosamente não inserir o alias duplicado (canonicalSet guard in mergeLeads).
 *
 * Select call sequence:
 *   1. Find aliases → [A's email, B's phone, B's email_DUPLICATE] (B has email same as A)
 *   2. resolveCanonical(A) → active
 *   3. resolveCanonical(B) → active
 *   4. mergeLeads: fetch lead rows [A, B]
 *   5. mergeLeads: active aliases of B → [phone_hash, email_hash (duplicate of A!)]
 *   6. mergeLeads: existing active aliases of A → [email_hash]  ← prevents duplicate
 *   7. updateExistingLead (end): existing aliases of A → [email, phone]
 */
function makeMergeDb_aliasConflict() {
  const insertedRows: Array<{ values: unknown }> = [];
  const updatedRows: Array<{ set: unknown }> = [];

  let selectCallIdx = 0;

  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCallIdx++;
      const idx = selectCallIdx;

      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            makeThenableWhere(
              idx === 1
                ? [
                    {
                      id: 'alias-A-email',
                      leadId: LEAD_A_ID,
                      identifierType: 'email_hash',
                      identifierHash: 'hash-email',
                    },
                    {
                      id: 'alias-B-phone',
                      leadId: LEAD_B_ID,
                      identifierType: 'phone_hash',
                      identifierHash: 'hash-phone',
                    },
                  ]
                : idx === 2
                  ? [{ status: 'active', mergedIntoLeadId: null }]
                  : idx === 3
                    ? [{ status: 'active', mergedIntoLeadId: null }]
                    : idx === 4
                      ? [
                          {
                            id: LEAD_A_ID,
                            firstSeenAt: LEAD_A_FIRST_SEEN,
                            status: 'active',
                            workspaceId: WORKSPACE_ID,
                          },
                          {
                            id: LEAD_B_ID,
                            firstSeenAt: LEAD_B_FIRST_SEEN,
                            status: 'active',
                            workspaceId: WORKSPACE_ID,
                          },
                        ]
                      : idx === 5
                        ? [
                            // B has phone_hash AND email_hash (same as A — conflict!)
                            {
                              id: 'alias-B-phone',
                              identifierType: 'phone_hash',
                              identifierHash: 'hash-phone',
                            },
                            {
                              id: 'alias-B-email-dup',
                              identifierType: 'email_hash',
                              identifierHash: 'hash-email',
                            },
                          ]
                        : idx === 6
                          ? [
                              {
                                identifierType: 'email_hash',
                                identifierHash: 'hash-email',
                              },
                            ] // A already has email
                          : [
                              {
                                identifierType: 'email_hash',
                                identifierHash: 'hash-email',
                              },
                              {
                                identifierType: 'phone_hash',
                                identifierHash: 'hash-phone',
                              },
                            ],
            ),
          ),
        }),
      };
    }),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((setValues: unknown) => ({
        where: vi.fn().mockImplementation(() => {
          updatedRows.push({ set: setValues });
          return Promise.resolve([]);
        }),
      })),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        insertedRows.push({ values: vals });
        return Promise.resolve([]);
      }),
    })),
  } as unknown as Parameters<typeof resolveLeadByAliases>[2];

  return { db, insertedRows, updatedRows };
}

describe('TC-08-03: alias duplicado em B não inserido no canonical após merge', () => {
  it('merge não insere alias source=merge quando canonical já tem mesmo hash', async () => {
    // BR-IDENTITY-001: aliases únicos — canonicalSet guard evita duplicata
    const { db, insertedRows } = makeMergeDb_aliasConflict();

    const result = await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lead_id).toBe(LEAD_A_ID);

    // Verifica que email_hash de B não foi re-inserido no canonical
    // (porque canonical já tinha email_hash — canonicalSet guard)
    const flatRows = flattenInsertedRows(insertedRows);
    const mergeAliasInserts = flatRows.filter(
      (v) => v.source === 'merge' && v.identifierType === 'email_hash',
    );
    // email_hash de B NÃO deve ter sido inserido novamente (já existe em A)
    expect(mergeAliasInserts).toHaveLength(0);
  });

  it('phone_hash de B (não existente em A) SIM é inserido no canonical via merge', async () => {
    // BR-IDENTITY-001: phone_hash não estava em A → deve ser movido
    const { db, insertedRows } = makeMergeDb_aliasConflict();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    const flatRows = flattenInsertedRows(insertedRows);
    const phoneAlias = flatRows.find(
      (v) => v.source === 'merge' && v.identifierType === 'phone_hash',
    );
    expect(phoneAlias).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TC-08-04: Idempotência do merge — re-processar não duplica lead_merges
// ---------------------------------------------------------------------------

/**
 * Simula B já mergeado: resolveCanonical de B retorna A (merged_into_lead_id=A)
 * Com isso, uniqueCanonicalIds terá só 1 elemento → Case B (updateExistingLead)
 * → merge_executed=false
 */
function makeMergeDb_alreadyMerged() {
  const insertedRows: Array<{ values: unknown }> = [];
  const updatedRows: Array<{ set: unknown }> = [];

  let selectCallIdx = 0;

  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCallIdx++;
      const idx = selectCallIdx;

      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            makeThenableWhere(
              idx === 1
                ? [
                    // email alias → A, phone alias → B (B já está merged em A)
                    {
                      id: 'alias-A-email',
                      leadId: LEAD_A_ID,
                      identifierType: 'email_hash',
                      identifierHash: 'hash-email',
                    },
                    {
                      id: 'alias-B-phone',
                      leadId: LEAD_B_ID,
                      identifierType: 'phone_hash',
                      identifierHash: 'hash-phone',
                    },
                  ]
                : idx === 2
                  ? [{ status: 'active', mergedIntoLeadId: null }] // A is active
                  : idx === 3
                    ? [{ status: 'merged', mergedIntoLeadId: LEAD_A_ID }] // B is merged → resolveCanonical returns A
                    : [
                        {
                          identifierType: 'email_hash',
                          identifierHash: 'hash-email',
                        },
                        {
                          identifierType: 'phone_hash',
                          identifierHash: 'hash-phone',
                        },
                      ],
            ),
          ),
        }),
      };
    }),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((setValues: unknown) => ({
        where: vi.fn().mockImplementation(() => {
          updatedRows.push({ set: setValues });
          return Promise.resolve([]);
        }),
      })),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        insertedRows.push({ values: vals });
        return Promise.resolve([]);
      }),
    })),
  } as unknown as Parameters<typeof resolveLeadByAliases>[2];

  return { db, insertedRows, updatedRows };
}

describe('TC-08-04: idempotência do merge — re-processar não duplica lead_merges', () => {
  it('quando B já está merged em A, segunda chamada retorna merge_executed=false', async () => {
    // INV-IDENTITY-003: resolver redireciona merged → canonical
    // B já está merged → resolveCanonical(B) retorna A → uniqueCanonicalIds=[A] → Case B
    const { db } = makeMergeDb_alreadyMerged();

    const result = await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // merge_executed=false porque B foi redirecionado para A antes do merge
    expect(result.value.merge_executed).toBe(false);
    expect(result.value.lead_id).toBe(LEAD_A_ID);
  });

  it('quando B já está merged, nenhuma nova row em lead_merges é inserida', async () => {
    const { db, insertedRows } = makeMergeDb_alreadyMerged();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    // Nenhuma row com canonicalLeadId deve ter sido inserida (sem merge novo)
    const flatRows = flattenInsertedRows(insertedRows);
    const mergeRows = flatRows.filter((v) => 'canonicalLeadId' in v);
    expect(mergeRows).toHaveLength(0);
  });

  it('quando B já está merged, lead B não recebe update de status=merged novamente', async () => {
    // BR-IDENTITY-004: lead merged não recebe novos aliases ou eventos
    const { db, updatedRows } = makeMergeDb_alreadyMerged();

    await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      db,
    );

    // Não deve haver update de status='merged' (B já está merged — não re-mergear)
    const mergeStatusUpdates = updatedRows.filter((r) => {
      const s = r.set as Record<string, unknown>;
      return s && s.status === 'merged';
    });
    expect(mergeStatusUpdates).toHaveLength(0);
  });
});
