#!/usr/bin/env bash
# Install playwright if needed, then run a single verification: one.sh <name>
set -uo pipefail
cd /work
export HOME=/work
if ! node -e "require('playwright')" 2>/dev/null; then
  echo "=== installing playwright ==="
  npm init -y >/dev/null 2>&1
  npm i playwright@latest >/dev/null 2>&1
  npx playwright install chromium >/dev/null 2>&1
fi
node "${1}.mjs"
