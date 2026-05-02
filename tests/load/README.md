# Load Tests — GlobalTracker

T-ID: T-1-022
Target: `POST /v1/events` (CONTRACT-api-events-v1)
NFR: RNF-001 — 1000 req/s, p95 < 50ms, zero 5xx

---

## Pre-requisites

### 1. Install k6

macOS (Homebrew):

```bash
brew install k6
```

Linux (binary):

```bash
curl https://github.com/grafana/k6/releases/download/v0.54.0/k6-v0.54.0-linux-amd64.tar.gz -L | tar xvz
sudo cp k6-v0.54.0-linux-amd64/k6 /usr/local/bin
```

Verify installation:

```bash
k6 version
```

### 2. Start the Edge worker locally

```bash
pnpm --filter @globaltracker/edge wrangler:dev
# or from repo root:
pnpm dev:edge
```

The worker listens on `http://localhost:8787` by default.

### 3. Prepare env vars

The load test requires three IDs that identify a valid workspace context:

| Var | Description | Where to get |
|---|---|---|
| `LAUNCH_PUBLIC_ID` | Public ID of a launch (e.g. `lnch_01HXY...`) | Seed script (T-1-021) or Supabase Studio > `launches` table |
| `PAGE_PUBLIC_ID` | Public ID of a page linked to that launch | Supabase Studio > `pages` table |
| `PAGE_TOKEN` | `X-Funil-Site` token for that page (`pk_live_...` or `pk_test_...`) | Supabase Studio > `pages.page_token` |

**If you ran the seed script from T-1-021**, it prints these values at the end.

**Manual lookup via Supabase CLI:**

```bash
# Get a page token from a test workspace
pnpm supabase db execute --sql "SELECT p.page_token, p.public_id, l.public_id AS launch_id FROM pages p JOIN launches l ON l.id = p.launch_id WHERE l.status = 'active' LIMIT 1;"
```

---

## Running the load test

```bash
k6 run \
  -e LAUNCH_PUBLIC_ID=<launch_public_id> \
  -e PAGE_PUBLIC_ID=<page_public_id> \
  -e PAGE_TOKEN=<page_token> \
  -e BASE_URL=http://localhost:8787 \
  tests/load/events-fast-accept.ts
```

Example with test values:

```bash
k6 run \
  -e LAUNCH_PUBLIC_ID=lnch_test_01 \
  -e PAGE_PUBLIC_ID=page_test_01 \
  -e PAGE_TOKEN=pk_test_abc123 \
  -e BASE_URL=http://localhost:8787 \
  tests/load/events-fast-accept.ts
```

### Optional flags

| Flag | Purpose |
|---|---|
| `--out json=results.json` | Save raw results to file for later analysis |
| `--summary-export=summary.json` | Save summary metrics to JSON |
| `-q` | Quiet mode — print only summary |

---

## Understanding the results

k6 prints a summary at the end of the run. Key metrics for RNF-001:

```
http_req_duration.............: avg=12ms    min=3ms    med=10ms    max=95ms    p(90)=22ms  p(95)=28ms
http_req_failed...............: 0.00%   ✓ 0       ✗ 60000
checks........................: 99.97%  ✓ 179991  ✗ 9
duplicate_events..............: 0.00%   ✓ 0       ✗ 60000
body_parse_errors.............: 0.00%   ✓ 0       ✗ 60000
```

### Metric reference

| Metric | What it measures |
|---|---|
| `http_req_duration p(95)` | 95th percentile response latency — the RNF-001 gate |
| `http_req_failed` | % of requests that received a network error or 5xx response |
| `checks` | % of per-iteration assertions that passed (status 202, body shape, status field) |
| `duplicate_events` | % of responses with `status=duplicate_accepted` (should be near 0 with unique UUIDs) |
| `body_parse_errors` | % of responses where JSON.parse failed — indicates malformed response body |

### Pass / fail criteria (RNF-001)

The test **passes** when all three thresholds are green at the end:

| Threshold | Criterion | Failure means |
|---|---|---|
| `http_req_duration p(95) < 50ms` | p95 latency under 50ms | Worker is too slow; check DB/KV latency |
| `http_req_failed < 0.1%` | Near-zero failures | Worker returning 5xx; check wrangler logs |
| `checks > 99%` | Almost all assertions pass | Response body shape mismatch; check CONTRACT-api-events-v1 |

k6 exits with a non-zero code when any threshold fails, so it integrates naturally with CI pipelines.

---

## Environment notes

### Local vs production

This load test targets `wrangler dev` (local). In local mode:

- KV is simulated in memory (low latency).
- Hyperdrive is not available; DB may be a real Supabase connection or stubbed.
- The fast-accept model (`INV-EVENT-005`) allows the handler to return 202 even without a DB insert (`insertRawEvent` is optional).

Expect p95 < 50ms easily in local. In production (CF edge + Hyperdrive) latency will be equal or lower.

### Rate limit interaction

The middleware applies a sliding-window rate limit of 100 req/min per workspace (configurable). Running 1000 req/s against a single `PAGE_TOKEN` will trigger rate limiting (429) unless the limit is raised for the test workspace.

To bypass for load testing, set a higher rate limit for the test workspace in the seeded data, or use `wrangler dev --local` which may not enforce KV-backed rate limits.

If you see `http_req_failed` rising with 429 responses, raise the rate limit for the test workspace before running.

### Interpreting duplicate_accepted

A non-zero `duplicate_events` rate in a fresh run indicates UUID collisions (statistically negligible with ~60k events) or a sticky KV state from a previous run. To reset KV state between runs, restart `wrangler dev`.
