/**
 * Unit tests — workspace-tags.ts (catálogo de tags por workspace).
 *
 * T-TAGS-008 (test author) cobrindo helpers de T-TAGS-002.
 *
 * Mocked DB; verifies:
 *   - INV-WORKSPACE-TAG-001: createTag duplicate → returns {ok:false, error:'duplicate'}.
 *   - INV-WORKSPACE-TAG-003: rename atualiza workspace_tags E lead_tags em
 *     transação atômica; colisão durante rename → rollback (rejeita transação).
 *   - autoRegisterTag idempotência (concurrency simulado — múltiplos calls em
 *     paralelo retornam ok=true sem throw).
 *   - updateTag(not_found) detectado dentro da transação.
 *
 * Estratégia de mock:
 *   - `db.execute` → vi.fn que devolve fixtures pré-formatadas (rows como
 *     postgres-js retorna: array de objetos snake_case).
 *   - `db.transaction(cb)` → executa `cb` com o mesmo mock `db` como `tx`
 *     (simula transaction "in-band"). Para testar rollback de erro,
 *     a transação propaga o throw para o caller, igual ao postgres-js real.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  autoRegisterTag,
  createTag,
  updateTag,
} from '../../../apps/edge/src/lib/workspace-tags';

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';
const TAG_ID = 'tag-00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

/**
 * makeMockDb: builds a Drizzle-shaped Db mock with:
 *   - execute(sql) → returns next response from `responses` queue, or throws.
 *   - transaction(cb) → calls `cb(tx)` where tx === db; throws bubblam ao caller
 *     (semântica do postgres.js: throw na callback faz ROLLBACK).
 *
 * `responses` é uma fila — cada chamada de execute consome o próximo item.
 * Cada item é {rows} (resolve) ou {error} (reject).
 */
type Response = { rows: unknown[] } | { error: Error };

function makeMockDb(responses: Response[]) {
  const queue = [...responses];
  const executeSpy = vi.fn(async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('mock_db: no more responses queued');
    }
    if ('error' in next) {
      throw next.error;
    }
    return next.rows;
  });

  const transactionSpy = vi.fn(
    async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      // Postgres.js: throw dentro da callback rejeita a transaction (ROLLBACK).
      // Aqui só propagamos.
      return cb(db);
    },
  );

  const db = {
    execute: executeSpy,
    transaction: transactionSpy,
  } as unknown as Parameters<typeof createTag>[0]['db'];

  return { db, executeSpy, transactionSpy };
}

// ---------------------------------------------------------------------------
// autoRegisterTag
// ---------------------------------------------------------------------------

describe('autoRegisterTag (T-TAGS-002, INV-WORKSPACE-TAG-001/002)', () => {
  it('returns ok=true on successful INSERT (idempotência via ON CONFLICT)', async () => {
    const { db, executeSpy } = makeMockDb([{ rows: [] }]);

    const result = await autoRegisterTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'wpp_joined',
      source: 'system:blueprint',
    });

    expect(result).toEqual({ ok: true });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('returns ok=true mesmo quando tag já existe (ON CONFLICT DO NOTHING é silencioso)', async () => {
    // O mock retorna rows vazias — postgres-js comporta-se igual com ou sem conflito;
    // o helper não distingue (idempotente por design).
    const { db } = makeMockDb([{ rows: [] }]);

    const result = await autoRegisterTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'wpp_joined',
      source: 'system:auto-registered',
    });

    expect(result).toEqual({ ok: true });
  });

  it('idempotência sob concurrency: 3 calls paralelos com mesma tag → todos ok=true', async () => {
    // Simula concurrency real: 3 INSERTs paralelos no Postgres com ON CONFLICT
    // DO NOTHING — todos resolvem ok. Cada call consome uma resposta da fila.
    const { db, executeSpy } = makeMockDb([
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);

    const results = await Promise.all([
      autoRegisterTag({
        db,
        workspaceId: WORKSPACE_ID,
        name: 'concurrent_tag',
        source: 'system:blueprint',
      }),
      autoRegisterTag({
        db,
        workspaceId: WORKSPACE_ID,
        name: 'concurrent_tag',
        source: 'system:blueprint',
      }),
      autoRegisterTag({
        db,
        workspaceId: WORKSPACE_ID,
        name: 'concurrent_tag',
        source: 'system:blueprint',
      }),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(executeSpy).toHaveBeenCalledTimes(3);
  });

  it('returns ok=false with error message on DB throw', async () => {
    const { db } = makeMockDb([{ error: new Error('connection_refused') }]);

    const result = await autoRegisterTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'will_fail',
      source: 'system:blueprint',
    });

    expect(result).toEqual({ ok: false, error: 'connection_refused' });
  });

  it('SQL inclui ON CONFLICT (workspace_id, name) DO NOTHING (INV-WORKSPACE-TAG-001)', async () => {
    const { db, executeSpy } = makeMockDb([{ rows: [] }]);

    await autoRegisterTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'inspectable',
      source: 'system:blueprint',
    });

    const sqlArg = executeSpy.mock.calls[0]?.[0] as {
      queryChunks?: unknown[];
    };
    const flat = JSON.stringify(sqlArg.queryChunks ?? []);
    expect(flat).toContain('INSERT INTO workspace_tags');
    expect(flat).toContain('ON CONFLICT');
    expect(flat).toContain('DO NOTHING');
  });
});

// ---------------------------------------------------------------------------
// createTag
// ---------------------------------------------------------------------------

describe('createTag (T-TAGS-002, INV-WORKSPACE-TAG-001, BR-AUDIT-001)', () => {
  function makeReturnedRow(name: string) {
    return {
      id: TAG_ID,
      workspace_id: WORKSPACE_ID,
      name,
      color: '#ff0000',
      description: 'desc',
      created_by: 'user:abc',
      created_at: new Date('2026-05-19T12:00:00Z'),
      archived_at: null,
    };
  }

  it('returns ok=true com tag mapeada em camelCase quando INSERT bem-sucedido', async () => {
    const row = makeReturnedRow('vip_main');
    const { db } = makeMockDb([{ rows: [row] }]);

    const result = await createTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'vip_main',
      color: '#ff0000',
      description: 'desc',
      createdBy: 'user:abc',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tag).toMatchObject({
        id: TAG_ID,
        workspaceId: WORKSPACE_ID,
        name: 'vip_main',
        color: '#ff0000',
        description: 'desc',
        createdBy: 'user:abc',
        archivedAt: null,
      });
      expect(result.tag.createdAt).toBeInstanceOf(Date);
    }
  });

  it('INV-WORKSPACE-TAG-001: returns {ok:false, error:"duplicate"} em violação 23505', async () => {
    // Postgres error code 23505 = unique_violation
    const pgErr = new Error(
      'duplicate key value violates unique constraint "workspace_tags_workspace_name_uniq" (23505)',
    );
    const { db } = makeMockDb([{ error: pgErr }]);

    const result = await createTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'vip_main',
      createdBy: 'user:abc',
    });

    expect(result).toEqual({ ok: false, error: 'duplicate' });
  });

  it('detecta duplicate via texto "duplicate key" (sem código numérico)', async () => {
    const pgErr = new Error('duplicate key on workspace_tags');
    const { db } = makeMockDb([{ error: pgErr }]);

    const result = await createTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'x',
      createdBy: 'user:abc',
    });

    expect(result).toEqual({ ok: false, error: 'duplicate' });
  });

  it('erro não-unique vira error:"unknown" com message truncada', async () => {
    const { db } = makeMockDb([{ error: new Error('connection lost') }]);

    const result = await createTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'x',
      createdBy: 'user:abc',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unknown');
      expect(result.message).toBe('connection lost');
    }
  });

  it('returns ok=false quando INSERT volta sem rows (caso patológico)', async () => {
    const { db } = makeMockDb([{ rows: [] }]);

    const result = await createTag({
      db,
      workspaceId: WORKSPACE_ID,
      name: 'x',
      createdBy: 'user:abc',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// updateTag — rename atômico + rollback (INV-WORKSPACE-TAG-003)
// ---------------------------------------------------------------------------

describe('updateTag rename (T-TAGS-002, INV-WORKSPACE-TAG-003)', () => {
  /**
   * Sequence de mock para um rename bem-sucedido:
   *   1) SELECT ... FOR UPDATE → [{ name: oldName }]
   *   2) UPDATE workspace_tags SET name = ... RETURNING → [updatedRow]
   *   3) UPDATE lead_tags SET tag_name = ... → []  (no RETURNING needed)
   */

  it('rename atualiza workspace_tags E propaga em lead_tags na MESMA transação', async () => {
    const updatedRow = {
      id: TAG_ID,
      workspace_id: WORKSPACE_ID,
      name: 'new_name',
      color: null,
      description: null,
      created_by: 'user:abc',
      created_at: new Date(),
      archived_at: null,
    };

    const { db, executeSpy, transactionSpy } = makeMockDb([
      { rows: [{ name: 'old_name' }] }, // SELECT FOR UPDATE
      { rows: [updatedRow] }, // UPDATE workspace_tags
      { rows: [] }, // UPDATE lead_tags (propagação)
    ]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: { name: 'new_name' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tag.name).toBe('new_name');
    }
    expect(transactionSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledTimes(3);

    // Verifica que a 3a chamada foi UPDATE em lead_tags com workspace_id anchor.
    const leadTagsSqlArg = executeSpy.mock.calls[2]?.[0] as {
      queryChunks?: unknown[];
    };
    const flat = JSON.stringify(leadTagsSqlArg.queryChunks ?? []);
    expect(flat).toContain('UPDATE lead_tags');
    expect(flat).toContain('workspace_id');
    expect(flat).toContain('tag_name');
  });

  it('skip propagação em lead_tags quando rename "para mesmo nome" (oldName === newName)', async () => {
    // Operador "renomeia" para o mesmo nome: SELECT volta com name=newName,
    // UPDATE workspace_tags roda, mas UPDATE lead_tags é PULADO (economia I/O).
    const updatedRow = {
      id: TAG_ID,
      workspace_id: WORKSPACE_ID,
      name: 'same_name',
      color: '#f00',
      description: null,
      created_by: 'user:abc',
      created_at: new Date(),
      archived_at: null,
    };

    const { db, executeSpy } = makeMockDb([
      { rows: [{ name: 'same_name' }] }, // SELECT FOR UPDATE
      { rows: [updatedRow] }, // UPDATE workspace_tags
      // No 3rd response queued — se o helper tentar UPDATE lead_tags, vai
      // estourar "no more responses queued".
    ]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: { name: 'same_name', color: '#f00' },
    });

    expect(result.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('INV-WORKSPACE-TAG-003: colisão durante rename → error:"duplicate" (rollback implícito)', async () => {
    // Cenário: SELECT FOR UPDATE ok, mas UPDATE workspace_tags estoura 23505
    // porque outro newName já existe no workspace. A transação rejeita; helper
    // captura e devolve duplicate. lead_tags NUNCA é tocado (ordem da SQL).
    const { db, executeSpy, transactionSpy } = makeMockDb([
      { rows: [{ name: 'old_name' }] }, // SELECT FOR UPDATE
      { error: new Error('duplicate key value violates unique constraint (23505)') },
    ]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: { name: 'colliding_name' },
    });

    expect(result).toEqual({ ok: false, error: 'duplicate' });
    // Apenas 2 calls — propagação em lead_tags NÃO ocorreu (rollback).
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(transactionSpy).toHaveBeenCalledOnce();
  });

  it('returns error:"not_found" quando SELECT FOR UPDATE não acha row (cross-workspace bloqueado)', async () => {
    const { db, executeSpy } = makeMockDb([
      { rows: [] }, // SELECT FOR UPDATE vazio — tag não existe ou pertence a outro ws
    ]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: { name: 'whatever' },
    });

    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('returns error:"unknown" em erro não-unique não-not_found', async () => {
    const { db } = makeMockDb([
      { rows: [{ name: 'old_name' }] },
      { error: new Error('temporary network blip') },
    ]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: { name: 'new_name' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// updateTag — caminho sem rename
// ---------------------------------------------------------------------------

describe('updateTag (sem rename — UPDATE simples sem transação)', () => {
  it('atualiza color sem chamar transaction()', async () => {
    const updatedRow = {
      id: TAG_ID,
      workspace_id: WORKSPACE_ID,
      name: 'unchanged',
      color: '#00ff00',
      description: null,
      created_by: 'user:abc',
      created_at: new Date(),
      archived_at: null,
    };

    const { db, executeSpy, transactionSpy } = makeMockDb([
      { rows: [updatedRow] }, // UPDATE workspace_tags
    ]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: { color: '#00ff00' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tag.color).toBe('#00ff00');
    }
    // BR: sem rename → caminho simples (sem transação).
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('returns error:"not_found" quando UPDATE simples não acha row', async () => {
    const { db } = makeMockDb([{ rows: [] }]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: { color: '#000000' },
    });

    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('patch totalmente vazio: faz SELECT only e devolve tag atual', async () => {
    const row = {
      id: TAG_ID,
      workspace_id: WORKSPACE_ID,
      name: 'current',
      color: null,
      description: null,
      created_by: 'user:abc',
      created_at: new Date(),
      archived_at: null,
    };
    const { db, transactionSpy } = makeMockDb([{ rows: [row] }]);

    const result = await updateTag({
      db,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      patch: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tag.name).toBe('current');
    }
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});
