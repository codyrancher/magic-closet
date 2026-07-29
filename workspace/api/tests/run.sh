#!/usr/bin/env bash
# Run the integration suite. It boots the real api in-process with docker + the
# network mocked (no containers/Rancher/AWS needed). Uses a node:22 container so
# it works even without node on the host.
set -euo pipefail
cd "$(dirname "$0")/../../.."

docker run --rm -v "$PWD:/app" -w /app node:22-bookworm \
  bash -c "node --test --test-concurrency=1 workspace/api/tests/api.test.mjs"
