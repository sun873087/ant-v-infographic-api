#!/usr/bin/env bash
# 使用 curl 呼叫 Infographic API
# 用法: BASE_URL=http://localhost:3000 bash test/clients/curl.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/infographic-curl}"
mkdir -p "$OUT_DIR"

SYNTAX='infographic list-row-horizontal-icon-arrow
data
  items
    - label Plan
      desc Design
      icon mdi/lightbulb-outline
    - label Build
      icon mdi/hammer-screwdriver
    - label Ship
      icon mdi/rocket-launch'

echo "[curl] healthz"
curl -fsS "${BASE_URL}/healthz" >/dev/null

echo "[curl] POST /render (SVG)"
curl -fsS -X POST "${BASE_URL}/render" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$SYNTAX" '{syntax:$s}')" \
  -o "${OUT_DIR}/out.svg"

echo "[curl] POST /render?format=png (PNG)"
curl -fsS -X POST "${BASE_URL}/render?format=png" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$SYNTAX" '{syntax:$s}')" \
  -o "${OUT_DIR}/out.png"

echo "[curl] GET /render/:encoded.svg (Kroki style)"
ENCODED=$(printf '%s' "$SYNTAX" | base64 | tr '+/' '-_' | tr -d '=' | tr -d '\n')
curl -fsS "${BASE_URL}/render/${ENCODED}.svg" -o "${OUT_DIR}/get.svg"

ls -la "$OUT_DIR"
