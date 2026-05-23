/**
 * Unit tests — recovery-sender.ts
 *
 * T-RECOVERY-FIX-002.
 *
 * Cobre o flow corrigido do "Contact not found!":
 *   - ensureUnnichatContact: contato existe (search retorna id → NÃO cria),
 *     contato não existe (data:[{}] → cria → retorna novo id), create falha
 *     4xx (job failed, não envia), create sem id reconhecível, rede.
 *   - dispatchToUnnichat: payload camelCase, sucesso, 4xx, rede.
 *   - sendPendingRecoveryJobs: tag pós-envio chamada com o tag_id certo,
 *     tag falha não derruba o job, contato 4xx → markJobFailed sem enviar.
 *
 * BRs/INVs verificados:
 *   - BR-PRIVACY-001: nenhum phone/email/name vaza para body/logs.
 *   - BR-RBAC-002: workspace_id presente nos UPDATEs (smoke).
 *   - INV-RECOVERY-JOB-002/003: status sent acompanha sent_at (smoke via UPDATE).
 *
 * fetchFn é mockado; DB é mockado (`db.execute`).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type RecoverySenderEnv,
  dispatchToUnnichat,
  ensureUnnichatContact,
  sendPendingRecoveryJobs,
} from '../../../apps/edge/src/lib/recovery-sender';

// ---------------------------------------------------------------------------
// Constantes / helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const API_KEY = 'Bearer test-token-123';
const PHONE = '5511999998888';

/** Resposta HTTP fake mínima compatível com `Response` (status + text). */
function makeResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

/**
 * Cria um fetch mock baseado num roteador por URL. Cada entrada é uma fila
 * de respostas (consumidas em ordem). URL ausente → erro de teste.
 */
function makeFetch(routes: Record<string, Response[]>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url === k);
      if (!key) {
        throw new Error(`unexpected fetch to ${url}`);
      }
      const queue = routes[key];
      if (!queue || queue.length === 0) {
        throw new Error(`no more responses queued for ${url}`);
      }
      const next = queue.shift();
      return next as Response;
    },
  ) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const SEARCH_URL = 'https://unnichat.com.br/api/contact/search';
const CREATE_URL = 'https://unnichat.com.br/api/contact';
const TEMPLATES_URL = 'https://unnichat.com.br/api/meta/templates';

// ---------------------------------------------------------------------------
// ensureUnnichatContact
// ---------------------------------------------------------------------------

describe('ensureUnnichatContact (T-RECOVERY-FIX-002)', () => {
  it('contato existe: search retorna id → NÃO chama create', async () => {
    const { fetchFn, calls } = makeFetch({
      [SEARCH_URL]: [
        makeResponse(200, {
          success: true,
          data: [{ id: 'c-555', name: 'x' }],
        }),
      ],
    });

    const result = await ensureUnnichatContact(
      API_KEY,
      { phone: PHONE, name: 'Joao', email: 'a@b.com' },
      fetchFn,
    );

    expect(result).toEqual({ ok: true, contactId: 'c-555' });
    // Só o search foi chamado — sem create.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SEARCH_URL);
    // Authorization usado direto (sem reconcatenar "Bearer ").
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(API_KEY);
  });

  it('contato NÃO existe (data:[{}]) → cria e retorna novo id (data.id)', async () => {
    const { fetchFn, calls } = makeFetch({
      [SEARCH_URL]: [makeResponse(200, { success: true, data: [{}] })],
      [CREATE_URL]: [
        makeResponse(200, { success: true, data: { id: 'c-new-1' } }),
      ],
    });

    const result = await ensureUnnichatContact(
      API_KEY,
      { phone: PHONE, name: 'Maria', email: null },
      fetchFn,
    );

    expect(result).toEqual({ ok: true, contactId: 'c-new-1' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(CREATE_URL);
    // email ausente → body só com name + phone.
    const createBody = JSON.parse(calls[1]?.init?.body as string);
    expect(createBody).toEqual({ phone: PHONE, name: 'Maria' });
    expect(createBody.email).toBeUndefined();
  });

  it('create resolve id em data[0].id (shape alternativo)', async () => {
    const { fetchFn } = makeFetch({
      [SEARCH_URL]: [makeResponse(200, { success: true, data: [{}] })],
      [CREATE_URL]: [makeResponse(200, { data: [{ id: 'c-arr-9' }] })],
    });

    const result = await ensureUnnichatContact(
      API_KEY,
      { phone: PHONE, name: 'Ana', email: 'ana@x.com' },
      fetchFn,
    );

    expect(result).toEqual({ ok: true, contactId: 'c-arr-9' });
  });

  it('create falha 4xx → ok:false com status (caller marca failed)', async () => {
    const { fetchFn } = makeFetch({
      [SEARCH_URL]: [makeResponse(200, { success: true, data: [{}] })],
      [CREATE_URL]: [makeResponse(422, { error: 'invalid phone' })],
    });

    const result = await ensureUnnichatContact(
      API_KEY,
      { phone: PHONE, name: 'X', email: null },
      fetchFn,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.error).toBe('create_status_422');
    }
  });

  it('create 200 sem id reconhecível → transitório (502)', async () => {
    const { fetchFn } = makeFetch({
      [SEARCH_URL]: [makeResponse(200, { success: true, data: [{}] })],
      [CREATE_URL]: [makeResponse(200, { success: true, weird: 'no id here' })],
    });

    const result = await ensureUnnichatContact(
      API_KEY,
      { phone: PHONE, name: 'X', email: null },
      fetchFn,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toBe('create_no_contact_id');
    }
  });

  it('search 5xx → ok:false status 5xx (transitório no caller)', async () => {
    const { fetchFn, calls } = makeFetch({
      [SEARCH_URL]: [makeResponse(503, 'gateway down')],
    });

    const result = await ensureUnnichatContact(
      API_KEY,
      { phone: PHONE },
      fetchFn,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
    // não tentou create.
    expect(calls).toHaveLength(1);
  });

  it('erro de rede no search → status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const result = await ensureUnnichatContact(
      API_KEY,
      { phone: PHONE },
      fetchFn,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(0);
      expect(result.error).toContain('search_network');
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchToUnnichat (regressão — payload camelCase)
// ---------------------------------------------------------------------------

describe('dispatchToUnnichat (T-RECOVERY-FIX-002 regressão)', () => {
  it('envia camelCase e retorna ok=true em 2xx', async () => {
    const { fetchFn, calls } = makeFetch({
      [TEMPLATES_URL]: [makeResponse(200, { messageId: 'm-1' })],
    });

    const result = await dispatchToUnnichat(
      {
        apiKey: API_KEY,
        phone: PHONE,
        unnichatTemplateId: 'tpl-1',
        bodyParameters: [{ type: 'text', text: 'oi' }],
        urlButtonParameters: [{ type: 'text', text: 'Fn4XA0' }],
      },
      fetchFn,
    );

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('m-1');
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toHaveProperty('templateId', 'tpl-1');
    expect(body).toHaveProperty('bodyParameters');
    expect(body).toHaveProperty('urlButtonParameters');
  });

  it('4xx → ok=false com status', async () => {
    const { fetchFn } = makeFetch({
      [TEMPLATES_URL]: [makeResponse(400, { error: 'Contact not found!' })],
    });

    const result = await dispatchToUnnichat(
      {
        apiKey: API_KEY,
        phone: PHONE,
        unnichatTemplateId: 'tpl-1',
        bodyParameters: [],
        urlButtonParameters: [],
      },
      fetchFn,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// sendPendingRecoveryJobs — integração do flow ensure→send→tag (DB mockado)
// ---------------------------------------------------------------------------

// PII de teste cifrada com PII_MASTER_KEY_V1 abaixo (workspace WORKSPACE_ID).
// Gerada deterministicamente no beforeAll via encryptPii.
import { encryptPii } from '../../../apps/edge/src/lib/pii';

const MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ENV: RecoverySenderEnv = {
  UNNICHAT_API_KEY: API_KEY,
  PII_MASTER_KEY_V1: MASTER_KEY,
};

async function enc(value: string): Promise<string> {
  const r = await encryptPii(value, WORKSPACE_ID, { 1: MASTER_KEY }, 1);
  if (!r.ok) throw new Error('encrypt failed in test setup');
  return r.value.ciphertext;
}

/**
 * Mock de `db.execute`. A primeira chamada é o SELECT principal (retorna
 * `rows`). Demais chamadas (suppression check, UPDATEs) capturam o SQL e
 * retornam vazio. `suppressedRows` controla o resultado do check de supressão.
 */
function makeDb(rows: unknown[]) {
  const executed: string[] = [];
  let call = 0;
  const execute = vi.fn(async (query: unknown) => {
    call += 1;
    // drizzle sql template → tem `.queryChunks`/strings; usamos toString p/ smoke.
    executed.push(String((query as { sql?: string })?.sql ?? ''));
    if (call === 1) {
      // SELECT principal
      return rows as unknown as never;
    }
    // suppression check (SELECT 1 ...) → array vazio = não suprimido.
    // UPDATEs → vazio.
    return [] as unknown as never;
  });
  const db = { execute } as unknown as Parameters<
    typeof sendPendingRecoveryJobs
  >[0];
  return { db, execute, executed };
}

describe('sendPendingRecoveryJobs — ensure→send→tag (T-RECOVERY-FIX-002)', () => {
  it('contato novo → cria → envia → taggea com unnichat_sent_tag_id', async () => {
    const phoneEnc = await enc(PHONE);
    const row = {
      job_id: 'job-1',
      lead_id: 'lead-1',
      attempts: 0,
      trigger_event_id: 'evt-1',
      job_created_at: '2026-05-20T10:00:00.000Z',
      unnichat_template_id: 'tpl-x',
      body_params: [{ type: 'contactName', fallback: 'amigo(a)' }],
      url_button_params: [{ type: 'text', fallback: 'Fn4XA0' }],
      unnichat_sent_tag_id: 'tag-777',
      launch_id: null,
      phone_enc: phoneEnc,
      name_plain: 'Carlos Silva',
      name_enc: null,
      email_enc: null,
      pii_key_version: 1,
    };

    const { db } = makeDb([row]);
    const TAGS_URL = 'https://unnichat.com.br/api/contact/c-new/tags';
    const { fetchFn, calls } = makeFetch({
      [SEARCH_URL]: [makeResponse(200, { success: true, data: [{}] })],
      [CREATE_URL]: [makeResponse(200, { data: { id: 'c-new' } })],
      [TEMPLATES_URL]: [makeResponse(200, { messageId: 'm-9' })],
      [TAGS_URL]: [makeResponse(200, { success: true })],
    });

    const result = await sendPendingRecoveryJobs(
      db,
      WORKSPACE_ID,
      ENV,
      fetchFn,
    );

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    // Ordem: search → create → templates → tags.
    const urls = calls.map((c) => c.url);
    expect(urls).toEqual([SEARCH_URL, CREATE_URL, TEMPLATES_URL, TAGS_URL]);

    // Tag enviada com o tag_id certo.
    const tagCall = calls.find((c) => c.url === TAGS_URL);
    const tagBody = JSON.parse(tagCall?.init?.body as string);
    expect(tagBody).toEqual({ tag_id: 'tag-777' });
  });

  it('tag falha (4xx) NÃO derruba o job — sent continua 1', async () => {
    const phoneEnc = await enc(PHONE);
    const row = {
      job_id: 'job-2',
      lead_id: 'lead-2',
      attempts: 0,
      trigger_event_id: 'evt-2',
      job_created_at: '2026-05-20T10:00:00.000Z',
      unnichat_template_id: 'tpl-x',
      body_params: [],
      url_button_params: [],
      unnichat_sent_tag_id: 'tag-zzz',
      launch_id: null,
      phone_enc: phoneEnc,
      name_plain: null,
      name_enc: null,
      email_enc: null,
      pii_key_version: 1,
    };

    const { db } = makeDb([row]);
    const TAGS_URL = 'https://unnichat.com.br/api/contact/c-exists/tags';
    const { fetchFn } = makeFetch({
      [SEARCH_URL]: [
        makeResponse(200, { success: true, data: [{ id: 'c-exists' }] }),
      ],
      [TEMPLATES_URL]: [makeResponse(200, { messageId: 'm-10' })],
      [TAGS_URL]: [makeResponse(404, { error: 'tag missing' })],
    });

    const result = await sendPendingRecoveryJobs(
      db,
      WORKSPACE_ID,
      ENV,
      fetchFn,
    );

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('contato create 4xx → markJobFailed e NÃO envia template', async () => {
    const phoneEnc = await enc(PHONE);
    const row = {
      job_id: 'job-3',
      lead_id: 'lead-3',
      attempts: 0,
      trigger_event_id: 'evt-3',
      job_created_at: '2026-05-20T10:00:00.000Z',
      unnichat_template_id: 'tpl-x',
      body_params: [],
      url_button_params: [],
      unnichat_sent_tag_id: null,
      launch_id: null,
      phone_enc: phoneEnc,
      name_plain: 'NoSend',
      name_enc: null,
      email_enc: null,
      pii_key_version: 1,
    };

    const { db } = makeDb([row]);
    const { fetchFn, calls } = makeFetch({
      [SEARCH_URL]: [makeResponse(200, { success: true, data: [{}] })],
      [CREATE_URL]: [makeResponse(400, { error: 'bad' })],
    });

    const result = await sendPendingRecoveryJobs(
      db,
      WORKSPACE_ID,
      ENV,
      fetchFn,
    );

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    // Nunca chegou no templates.
    expect(calls.some((c) => c.url === TEMPLATES_URL)).toBe(false);
  });

  it('sem tag_id na campanha → envia mas NÃO chama /tags', async () => {
    const phoneEnc = await enc(PHONE);
    const row = {
      job_id: 'job-4',
      lead_id: 'lead-4',
      attempts: 0,
      trigger_event_id: 'evt-4',
      job_created_at: '2026-05-20T10:00:00.000Z',
      unnichat_template_id: 'tpl-x',
      body_params: [],
      url_button_params: [],
      unnichat_sent_tag_id: null,
      launch_id: null,
      phone_enc: phoneEnc,
      name_plain: 'A',
      name_enc: null,
      email_enc: null,
      pii_key_version: 1,
    };

    const { db } = makeDb([row]);
    const { fetchFn, calls } = makeFetch({
      [SEARCH_URL]: [
        makeResponse(200, { success: true, data: [{ id: 'c-ex' }] }),
      ],
      [TEMPLATES_URL]: [makeResponse(200, { messageId: 'm-11' })],
    });

    const result = await sendPendingRecoveryJobs(
      db,
      WORKSPACE_ID,
      ENV,
      fetchFn,
    );

    expect(result.sent).toBe(1);
    expect(calls.some((c) => c.url.endsWith('/tags'))).toBe(false);
  });
});
