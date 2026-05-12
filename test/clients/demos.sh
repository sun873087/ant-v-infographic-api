#!/usr/bin/env bash
# bash + curl + jq:讀 test/clients/demos/*.txt,把每個 syntax 渲染成 SVG + PNG。
# 用法: BASE_URL=http://localhost:3000 bash test/clients/demos.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNTAX_DIR="${SYNTAX_DIR:-${SCRIPT_DIR}/demos}"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/output/complex-curl}"
mkdir -p "$OUT_DIR"

echo "[sh] rendering $(ls -1 "$SYNTAX_DIR"/*.txt | wc -l | tr -d ' ') templates × {svg,png}  -> $OUT_DIR"

for syntax_file in "$SYNTAX_DIR"/*.txt; do
  name=$(basename "$syntax_file" .txt)
  syntax=$(cat "$syntax_file")
  for fmt in svg png; do
    curl -fsS -X POST "${BASE_URL}/render?format=${fmt}" \
      -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg s "$syntax" '{syntax:$s}')" \
      -o "${OUT_DIR}/${name}.${fmt}" \
      -w "  ${name}.${fmt}  %{http_code}  %{size_download}B\n"
  done
done
