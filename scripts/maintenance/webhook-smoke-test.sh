#!/usr/bin/env bash
#
# webhook-smoke-test.sh — sanity check inbound webhook endpoints
#
# Ping cada endpoint inbound (Guru, OnProfit, SendFlow) com payload junk.
# Falha (exit > 0) se algum retornar 5xx. Validation failures (4xx) são esperadas
# e contam como sucesso — o ponto é detectar "DB conn quebrada" disfarçada de 500.
#
# Quando rodar:
#   - Após rotação de senha Supabase
#   - Após reconfigurar Hyperdrive binding (novo ID ou connection string)
#   - Após `wrangler secret put DATABASE_URL`
#   - Após codemod que toque DB conn ou bindings
#   - Após deploy de rota webhook nova
#
# Contexto: incidente 2026-05-13 — 3 webhook routes ficaram com ordem antiga
# `DATABASE_URL ?? HYPERDRIVE` após codemod incompleto. DATABASE_URL secret estava
# divergente do binding → 500 silencioso por ~16h. Detalhes em ADR-046.
#
# Uso:
#   bash scripts/maintenance/webhook-smoke-test.sh                       # prod
#   EDGE_BASE_URL=http://localhost:8787 bash scripts/.../webhook-smoke-test.sh  # local
#   WORKSPACE_SLUG=outsiders bash scripts/.../webhook-smoke-test.sh      # outro ws

set -uo pipefail

BASE="${EDGE_BASE_URL:-https://globaltracker-edge.globaltracker.workers.dev}"
SLUG="${WORKSPACE_SLUG:-outsiders}"
PAYLOAD='{"test":true}'

# nome|url|content_type
ENDPOINTS=(
  "onprofit|$BASE/v1/webhooks/onprofit?workspace=$SLUG|application/json"
  "guru|$BASE/v1/webhook/guru?workspace=$SLUG|application/json"
  "sendflow|$BASE/v1/webhooks/sendflow?workspace=$SLUG|application/json"
)

echo "Smoke-testing webhooks at $BASE (workspace=$SLUG)"
echo "Expectation: 4xx = OK (validation failure is the right answer for junk body)"
echo "             5xx = FAIL (DB conn or unhandled exception — investigate)"
echo

fail=0
for entry in "${ENDPOINTS[@]}"; do
  IFS='|' read -r name url ctype <<< "$entry"
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 15 \
    -X POST \
    -H "Content-Type: $ctype" \
    -d "$PAYLOAD" \
    "$url" 2>/dev/null || echo "000")

  if [[ "$status" =~ ^5 ]] || [[ "$status" == "000" ]]; then
    printf "  FAIL  %-10s %s  ← 5xx / timeout — DB conn likely broken\n" "$name" "$status"
    fail=$((fail + 1))
  elif [[ "$status" =~ ^[23] ]] || [[ "$status" =~ ^4 ]]; then
    printf "  OK    %-10s %s\n" "$name" "$status"
  else
    printf "  WARN  %-10s %s  ← unexpected status\n" "$name" "$status"
    fail=$((fail + 1))
  fi
done

echo
if [[ $fail -eq 0 ]]; then
  echo "All webhook endpoints healthy."
  exit 0
else
  echo "FAILED: $fail endpoint(s) returned 5xx or timeout."
  echo "Investigate Hyperdrive binding, DATABASE_URL secret, or route DB factory order."
  echo "Ref: docs/90-meta/04-decision-log.md ADR-046"
  exit 1
fi
