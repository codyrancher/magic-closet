#!/bin/bash
# Installs the node version the workspace wants (from rancher/dashboard's .nvmrc,
# else the latest LTS) via nvm, into the shared /opt/toolchain volume, and links
# /opt/toolchain/node -> the active version. Both the closet container and the
# slim vscode sidecar put /opt/toolchain/node/bin on PATH, so they share node.
# Safe to re-run (e.g. after the workspace clone brings in a new .nvmrc).
set -e
export NVM_DIR="${NVM_DIR:-/opt/toolchain/nvm}"
mkdir -p "$NVM_DIR"

# Seed nvm into the shared volume from the image copy (once).
if [ ! -s "$NVM_DIR/nvm.sh" ] && [ -d /opt/nvm ]; then
    cp -a /opt/nvm/. "$NVM_DIR/"
fi
[ -s "$NVM_DIR/nvm.sh" ] || { echo "[setup-node] nvm unavailable" >&2; exit 0; }

# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"

want="--lts"
if [ -f /workspace/dashboard/.nvmrc ]; then
    want="$(tr -d ' \t\r\n' < /workspace/dashboard/.nvmrc)"
fi
nvm install "$want" >/dev/null 2>&1 || nvm install --lts >/dev/null 2>&1
corepack enable >/dev/null 2>&1 || true   # yarn/pnpm shims in the node bin dir

# Stable path both containers keep on PATH.
ln -sfn "$(dirname "$(dirname "$(nvm which current)")")" /opt/toolchain/node
echo "[setup-node] node $(node -v 2>/dev/null) ready at /opt/toolchain/node"
