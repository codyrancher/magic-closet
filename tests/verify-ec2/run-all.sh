#!/usr/bin/env bash
# Runs inside the mcr.microsoft.com/playwright container on the EC2 host with
# --network host. Installs playwright if the image doesn't already provide it,
# then runs each verification, recording a webm per item into videos-out/.
set -uo pipefail
cd /work
export HOME=/work

if ! node -e "require('playwright')" 2>/dev/null; then
  echo "=== installing playwright ==="
  npm init -y >/dev/null 2>&1
  npm i playwright@latest >/dev/null 2>&1
  npx playwright install chromium >/dev/null 2>&1
fi

mkdir -p videos-out
# Quick checks first, then the long provisioning run.
for s in running-on-ec2 figma appco provisioning; do
  echo "======== RUN ${s} ========"
  node "${s}.mjs"
  echo "======== END ${s} (exit $?) ========"
done
echo "======== ALL DONE ========"
