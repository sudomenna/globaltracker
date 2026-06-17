/**
 * backfill-clientes-workshop.ts
 *
 * DATA-ONLY backfill of Guru workshop sales from clientes_workshop.csv.
 * Mirrors processGuruRawEvent (guru-raw-events-processor.ts) data-side, but
 * SKIPS Step 6 (dispatch). No Meta/GA4/Google jobs are created.
 *
 * Reuses the real pipeline libs so identity resolution (incl. phone-match /
 * merge / alias attach for different-email buyers), PII hashing+encryption,
 * product upsert, monotonic lifecycle promotion, stages and tag-rules are
 * IDENTICAL to production.
 *
 * Scope (user decision 2026-06-13): PAID + WAITING.
 *   - PAID         → Guru 'approved'        → Purchase  (promotes to 'cliente')
 *   - WAITING      → Guru 'waiting_payment' → InitiateCheckout (no promotion)
 *   CANCELLED/REFUNDED are ignored.
 *
 * ⚠️ ALREADY RAN 2026-06-13 (corrected 2026-06-17). DO NOT RE-RUN without --force-rerun.
 * Idempotency is ONLY against this script's own derived event_id
 * (sha256("guru:transaction:<id>:<status>")[:32]) — it does NOT dedup against
 * real webhook-originated events. Re-running therefore RE-CREATES parallel
 * Purchase events that duplicate sales already captured by the OnProfit webhook
 * (this is exactly the bug fixed by scripts/maintenance/fix_onprofit_misattributed_to_guru.mjs).
 *
 * CORRECTION 2026-06-17: this CSV is OnProfit data → products are now attributed to
 * provider='onprofit' (ids 4852/4853/4854), NOT remapped to Guru marketplace ids.
 *
 * Usage (from repo root):
 *   npx tsx apps/edge/scripts/backfill-clientes-workshop.ts                 # dry-run (no writes)
 *   npx tsx apps/edge/scripts/backfill-clientes-workshop.ts --apply --paid-only --limit 5
 *   npx tsx apps/edge/scripts/backfill-clientes-workshop.ts --apply --paid-only
 *   npx tsx apps/edge/scripts/backfill-clientes-workshop.ts --apply        # full (PAID+WAITING)
 *
 * Env (.env.local): DATABASE_URL, PII_MASTER_KEY_V1
 */
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, events, leadStages, leads, workspaces } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { resolveLaunchForGuruEvent } from '../src/lib/guru-launch-resolver.js';
import { jsonb } from '../src/lib/jsonb-cast.js';
import { applyTagRules } from '../src/lib/lead-tags.js';
import { normalizePhone, resolveLeadByAliases } from '../src/lib/lead-resolver.js';
import { lifecycleForCategory } from '../src/lib/lifecycle-rules.js';
import { promoteLeadLifecycle } from '../src/lib/lifecycle-promoter.js';
import { enrichLeadPii } from '../src/lib/pii-enrich.js';
import { hashPiiExternal, splitName } from '../src/lib/pii.js';
import { upsertProduct } from '../src/lib/products-resolver.js';
import {
  type FunnelBlueprint,
  getBlueprintForLaunch,
  matchesStageFilters,
} from '../src/lib/raw-events-processor.js';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PAID_ONLY = argv.includes('--paid-only');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i >= 0 && argv[i + 1] ? Number.parseInt(argv[i + 1]!, 10) : Infinity;
})();
const CSV_PATH = (() => {
  const i = argv.indexOf('--csv');
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : 'clientes_workshop.csv';
})();
const CSV_TAG = CSV_PATH.split('/').pop() ?? CSV_PATH; // basename → custom_data.backfill_source

// ---------------------------------------------------------------------------
// RE-RUN GUARD (2026-06-17): this one-off already ran. It does NOT dedup against
// real webhook events, so re-applying duplicates live OnProfit sales. Require an
// explicit opt-in to write.
// ---------------------------------------------------------------------------
if (APPLY && !argv.includes('--force-rerun')) {
  console.error(
    'ABORT: backfill-clientes-workshop already ran (2026-06-13) and was corrected (2026-06-17).\n' +
      'Re-running RE-CREATES Purchase events that duplicate real OnProfit webhook sales\n' +
      '(it only dedups against its own derived event_id, not against webhook events).\n' +
      'If you really mean it, pass --force-rerun. Dry-run (no flag, no --apply) is always safe.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
) as Record<string, string>;

const db = createDb(env.DATABASE_URL);
const masterKeyHex = env.PII_MASTER_KEY_V1;

// ---------------------------------------------------------------------------
// Resolve CSV line → OnProfit product (the CSV IS OnProfit data).
// ---------------------------------------------------------------------------
// CSV quirk: product_id is the parent checkout id (4852) for almost EVERY line,
// including order bumps — the real bumped product is only in product_name. So we
// map by NAME to the correct OnProfit product id (provider='onprofit').
// NOTE (2026-06-17): previously this remapped to GURU marketplace ids, which
// mis-attributed OnProfit sales to the Guru products. Fixed to OnProfit ids.
function canonicalProduct(name: string | undefined, csvPid: string): { id: string; name: string; slug: 'workshop' | 'pack' | 'other' } {
  const n = (name ?? '').toLowerCase();
  if (/constitui/.test(n)) return { id: '4853', name: 'Pack Constituição e Sociedade', slug: 'pack' };
  if (/estruturas avan|vesting/.test(n)) return { id: '4854', name: 'Pack Estruturas Avançadas', slug: 'pack' };
  if (/workshop contratos societ/.test(n)) return { id: '4852', name: 'Workshop Contratos Societários', slug: 'workshop' };
  return { id: csvPid, name: name ?? 'Produto sem nome', slug: 'other' };
}

// funnel_role aligned to the launch BLUEPRINT (not launch_products, which drifted
// to 'bait_offer' and stopped firing purchased_workshop — the documented undercount
// bug). Blueprint: purchased_workshop + bait_purchased tag ← funnel_role='workshop';
// purchased_order_bump tag ← item_type='order_bump'.
function funnelRoleFor(slug: 'workshop' | 'pack' | 'other'): string {
  return slug === 'workshop' ? 'workshop' : 'bait_order_bump';
}

const STATUS_MAP: Record<string, { guru: string; eventType: 'Purchase' | 'InitiateCheckout' }> = {
  PAID: { guru: 'approved', eventType: 'Purchase' },
  WAITING: { guru: 'waiting_payment', eventType: 'InitiateCheckout' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()!;
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]!])));
}

async function deriveGuruEventId(webhookType: string, id: string, status: string): Promise<string> {
  // BR-WEBHOOK-002: event_id = sha256("guru:" + webhook_type + ":" + id + ":" + status)[:32] (hex)
  const input = `guru:${webhookType}:${id}:${status}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function parseBrtDate(s: string): Date | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yy, h, mi, se] = m;
  const d = new Date(`${yy}-${mm}-${dd}T${h}:${mi}:${se}-03:00`); // CSV times are BRT
  return Number.isNaN(d.getTime()) ? null : d;
}

function maskEmail(e: string): string {
  const [u, dom] = e.split('@');
  if (!dom) return '***';
  return `${(u ?? '').slice(0, 2)}***@${dom}`;
}

function parseAmount(v: string): number | null {
  const n = Number.parseFloat((v || '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function insertLeadStageIgnoreDup(input: {
  workspaceId: string; leadId: string; launchId: string; stage: string; isRecurring: boolean; sourceEventId: string;
}): Promise<void> {
  try {
    await db.insert(leadStages).values({
      workspaceId: input.workspaceId, leadId: input.leadId, launchId: input.launchId,
      stage: input.stage, isRecurring: input.isRecurring, sourceEventId: input.sourceEventId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!(msg.includes('23505') || /unique|duplicate key/i.test(msg))) throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const wsLookup = await db
  .select({ id: workspaces.id })
  .from(workspaces)
  .where(eq(workspaces.slug, 'outsiders'))
  .limit(1);
const workspaceId = wsLookup[0]!.id;

const allRows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
const statuses = PAID_ONLY ? ['PAID'] : ['PAID', 'WAITING'];
const lines = allRows.filter((r) => statuses.includes(r.status ?? ''));

console.log(`=== Backfill clientes_workshop.csv → GT (ws ${workspaceId}) ===`);
console.log(`csv: ${CSV_PATH} (tag=${CSV_TAG}) | mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'} | scope: ${statuses.join('+')} | limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);
console.log(`candidate lines: ${lines.length}\n`);

const counts = {
  processed: 0, purchase: 0, ic: 0,
  leadsCreated: 0, merges: 0, phoneMatched: 0,
  eventsInserted: 0, eventsSkippedDup: 0, errors: 0, skippedNoId: 0,
};
const sample: string[] = [];
let blueprintCache: { launchId: string; bp: FunnelBlueprint | null } | null = null;

let n = 0;
for (const r of lines) {
  if (n >= LIMIT) break;
  n++;

  const sm = STATUS_MAP[r.status!];
  if (!sm) continue;
  const csvPid = (r.product_id ?? '').trim();
  const mapped = canonicalProduct(r.product_name, csvPid);
  const productId = mapped.id;
  const productName = mapped.name;
  const itemType = (r.item_type ?? '').trim().toLowerCase() === 'order bump' ? 'order_bump' : 'product';

  const lineId = (r.id ?? '').trim();
  if (!lineId) { counts.skippedNoId++; continue; }

  const email = (r.email ?? '').trim() || undefined;
  const rawPhone = `${(r.ddi ?? '').trim()}${(r.telefone ?? '').trim()}`;
  const phone = rawPhone ? (normalizePhone(rawPhone) ?? undefined) : undefined;
  const name = `${(r.nome ?? '').trim()} ${(r.sobrenome ?? '').trim()}`.trim() || undefined;
  const eventTime = parseBrtDate(r.data ?? '') ?? new Date();
  const eventId = await deriveGuruEventId('transaction', lineId, sm.guru);
  counts.processed++;
  if (sm.eventType === 'Purchase') counts.purchase++; else counts.ic++;

  // pre-insert idempotency lookup
  const existing = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.eventId, eventId)))
    .limit(1);
  const exists = !!existing[0];

  if (!APPLY) {
    if (exists) counts.eventsSkippedDup++; else counts.eventsInserted++;
    if (sample.length < 5) {
      const lr = await resolveLaunchForGuruEvent({ workspaceId, productId, leadHints: { email: email ?? null, phone: phone ?? null, visitorId: null }, db });
      sample.push(`  [${r.status}] ${sm.eventType} ${email ? maskEmail(email) : '(sem email)'} | ${productName.slice(0, 32)} | launch=${lr.launch_id ? 'ok' : 'NULL'} role=${funnelRoleFor(mapped.slug)} item=${itemType} | exists=${exists}`);
    }
    continue;
  }

  // ---- APPLY ----
  try {
    if (exists) { counts.eventsSkippedDup++; continue; }

    // Step 3: resolve lead (creates / merges / attaches new email alias for phone-match)
    const resolve = await resolveLeadByAliases({ email, phone }, workspaceId, db, { eventTime });
    if (!resolve.ok) { counts.errors++; console.warn(`  ! resolve failed line ${lineId}: ${resolve.error.code}`); continue; }
    const leadId = resolve.value.lead_id;
    if (resolve.value.was_created) counts.leadsCreated++;
    if (resolve.value.merge_executed) counts.merges++;

    // fn/ln hashes from name (mirror processor)
    if (name) {
      const { first, last } = splitName(name);
      const fn = first ? await hashPiiExternal(first) : null;
      const ln = last ? await hashPiiExternal(last) : null;
      if (fn || ln) {
        await db.update(leads).set({ ...(fn ? { fnHash: fn } : {}), ...(ln ? { lnHash: ln } : {}) })
          .where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)));
      }
    }

    // in-clear PII enrichment (email_enc/phone_enc/name/+fn-ln)
    try {
      await enrichLeadPii({ email, phone, name }, { leadId, workspaceId, db, masterKeyHex, requestId: `backfill:${lineId}` });
    } catch (e) { /* soft-fail per INV-PRIVACY-006-soft */ }

    // launch_id from resolver (canonical); funnel_role aligned to blueprint design
    const lr = await resolveLaunchForGuruEvent({ workspaceId, productId, leadHints: { email: email ?? null, phone: phone ?? null, visitorId: null }, db });
    const launchId = lr.launch_id;
    const funnelRole = funnelRoleFor(mapped.slug);

    // product upsert + monotonic lifecycle promotion (Purchase only)
    let productDbId: string | null = null;
    if (sm.eventType === 'Purchase' && productId) {
      try {
        const product = await upsertProduct(db, { workspaceId, externalProvider: 'onprofit', externalProductId: String(productId), name: productName });
        productDbId = product.id;
        await promoteLeadLifecycle(db, leadId, lifecycleForCategory(workspaceId, product.category as never));
      } catch (e) { console.warn(`  ~ product/lifecycle soft-fail line ${lineId}`); }
    }

    // Step 4: insert event (mirror processor; NO dispatch)
    const amount = parseAmount(r.valor_oferta ?? '');
    const inserted = await db.insert(events).values({
      workspaceId,
      launchId: launchId ?? undefined,
      leadId,
      eventId,
      eventName: sm.eventType,
      eventSource: 'webhook:onprofit',
      schemaVersion: 1,
      eventTime,
      receivedAt: eventTime,
      attribution: jsonb({
        utm_source: r.utm_source || null, utm_campaign: r.utm_campaign || null,
        utm_medium: r.utm_medium || null, utm_content: r.utm_content || null, utm_term: r.utm_term || null,
      }),
      userData: jsonb({
        ...(r.cidade ? { geo_city: r.cidade } : {}),
        ...(r.estado ? { geo_region_code: r.estado } : {}),
        ...(r.cep ? { geo_postal_code: r.cep } : {}),
        ...(r.pais ? { geo_country: r.pais } : {}),
      }),
      customData: jsonb({
        funnel_role: funnelRole ?? null,
        item_type: itemType,
        amount, currency: 'BRL',
        product_id: productId, product_name: productName,
        ...(productDbId ? { product_db_id: productDbId } : {}),
        dates: null,
        backfill_source: CSV_TAG,
      }),
      consentSnapshot: jsonb({ analytics: 'granted', marketing: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', customer_match: 'granted' }),
      requestContext: jsonb({}),
      processingStatus: 'accepted',
      isTest: false,
    }).returning({ id: events.id });
    const insertedEventId = inserted[0]!.id;
    counts.eventsInserted++;

    // Step 5: lead_stages via blueprint (cached per launch)
    if (launchId) {
      if (!blueprintCache || blueprintCache.launchId !== launchId) {
        let bp: FunnelBlueprint | null = null;
        try { bp = await getBlueprintForLaunch(launchId, db); } catch { bp = null; }
        blueprintCache = { launchId, bp };
      }
      const bp = blueprintCache.bp;
      const cdForFilters: Record<string, unknown> = { funnel_role: funnelRole ?? null };
      if (bp) {
        for (const stage of bp.stages) {
          if (matchesStageFilters(sm.eventType, cdForFilters, stage)) {
            await insertLeadStageIgnoreDup({ workspaceId, leadId, launchId, stage: stage.slug, isRecurring: stage.is_recurring, sourceEventId: insertedEventId });
          }
        }
      } else if (sm.eventType === 'Purchase') {
        await insertLeadStageIgnoreDup({ workspaceId, leadId, launchId, stage: 'purchased', isRecurring: false, sourceEventId: insertedEventId });
      }
      // tag rules
      try {
        await applyTagRules({ db, workspaceId, leadId, eventName: sm.eventType, eventContext: { funnel_role: funnelRole ?? undefined, item_type: itemType }, tagRules: bp?.tag_rules });
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    counts.errors++;
    console.error(`  !! line ${lineId} error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }

  if (counts.processed % 100 === 0) console.log(`  ...${counts.processed} processed (inserted=${counts.eventsInserted} dup=${counts.eventsSkippedDup} newLeads=${counts.leadsCreated} merges=${counts.merges} err=${counts.errors})`);
}

console.log('\n=== RESULT ===');
console.log(counts);
if (sample.length) { console.log('\n-- sample --'); for (const s of sample) console.log(s); }
if (!APPLY) console.log('\n(DRY-RUN — nada foi escrito. Rode com --apply para persistir.)');

process.exit(0);
