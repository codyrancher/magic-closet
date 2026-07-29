#!/bin/bash
set -e

USER_ID=${PUID:-1000}
GROUP_ID=${PGID:-1000}

if ! getent group "$GROUP_ID" > /dev/null 2>&1; then
    groupadd -g "$GROUP_ID" dev
fi
if ! getent passwd "$USER_ID" > /dev/null 2>&1; then
    useradd -m -u "$USER_ID" -g "$GROUP_ID" -s /bin/bash dev
fi
USER_NAME=$(getent passwd "$USER_ID" | cut -d: -f1)
HOME_DIR=$(getent passwd "$USER_ID" | cut -d: -f6)
mkdir -p "$HOME_DIR"
chown "$USER_ID:$GROUP_ID" "$HOME_DIR"

# Shared Claude credentials/config (same volume as the project container) so
# the Claude extension uses the same login session
if [ -d /claude-data ]; then
    chown "$USER_ID:$GROUP_ID" /claude-data
    ln -sfn /claude-data "$HOME_DIR/.claude"
    [ -f /claude-data/.claude.json ] || touch /claude-data/.claude.json
    chown "$USER_ID:$GROUP_ID" /claude-data/.claude.json
    ln -sfn /claude-data/.claude.json "$HOME_DIR/.claude.json"
fi

# Node comes from the closet's shared /opt/toolchain volume (nvm, from the
# repo's .nvmrc), already on PATH — nothing to install here.

# gh: authenticate git through gh when a token is present (gh itself reads
# GH_TOKEN from the environment)
if [ -n "$GH_TOKEN" ]; then
    gosu "$USER_NAME" env GH_TOKEN="$GH_TOKEN" gh auth setup-git 2>/dev/null || true
fi

# Server state (settings, sessions) persists in the vscode-data volume
DATA_DIR=/data/openvscode-server
USER_DIR="$DATA_DIR/data/User"
DEFAULTS=/opt/magic-closet/template

# Clear cached state so fresh settings are applied on every boot
rm -rf "$USER_DIR/workspaceStorage" 2>/dev/null || true
rm -f "$USER_DIR/state.vscdb"* 2>/dev/null || true
rm -rf "$USER_DIR/History" 2>/dev/null || true
rm -f "$USER_DIR/globalStorage/state.vscdb"* 2>/dev/null || true

# User settings + keybindings
mkdir -p "$USER_DIR/globalStorage"
cp "$DEFAULTS/settings.json" "$USER_DIR/settings.json"
cp "$DEFAULTS/keybindings.json" "$USER_DIR/keybindings.json"

# Global state: mark welcome walkthroughs done, trust all domains, panel right
cp "$DEFAULTS/storage.json" "$USER_DIR/globalStorage/storage.json"

# Machine settings (take precedence — used for managed environments)
mkdir -p "$DATA_DIR/data/Machine"
cp "$DEFAULTS/machine-settings.json" "$DATA_DIR/data/Machine/settings.json"

# Pre-trust the workspace so no trust dialog appears
cp "$DEFAULTS/workspace-trust.json" "$USER_DIR/globalStorage/workspace-trust.json"

chown -R "$USER_ID:$GROUP_ID" /data

# Workspace-level settings (welcome page off, Claude permissions, Vue tweaks)
mkdir -p /workspace/.vscode
cp "$DEFAULTS/workspace-settings.json" /workspace/.vscode/settings.json
chown -R "$USER_ID:$GROUP_ID" /workspace/.vscode

# Extensions may need to write temp files
chown -R "$USER_ID:$GROUP_ID" /opt/vscode-extensions 2>/dev/null || true

# Update the Claude extension before the server starts (prevents mid-session
# auto-updates)
echo "Updating extensions..."
gosu "$USER_NAME" env \
    VSCODE_GALLERY_SERVICE_URL="$VSCODE_GALLERY_SERVICE_URL" \
    VSCODE_GALLERY_ITEM_URL="$VSCODE_GALLERY_ITEM_URL" \
    /opt/openvscode-server/bin/openvscode-server \
    --extensions-dir /opt/vscode-extensions \
    --install-extension anthropic.claude-code 2>/dev/null || true
echo "Extensions updated"

# HTTPS front door: VS Code web webviews need a secure context, which plain
# http:// on a remote IP isn't. openvscode has no TLS of its own, so terminate
# TLS in a tiny proxy (openvscode's bundled node) and forward to it on 9000.
# The published host port maps to 9443 (see compose.yml); 9000 stays http for
# in-network use and the healthcheck.
TLS_DIR=/data/tls
mkdir -p "$TLS_DIR"
if [ ! -f "$TLS_DIR/crt.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/crt.pem" \
        -subj "/CN=magic-closet-vscode" \
        -addext "subjectAltName=DNS:localhost,DNS:vscode,IP:127.0.0.1" >/dev/null 2>&1
    echo "generated vscode TLS cert ($TLS_DIR)"
fi
chown -R "$USER_ID:$GROUP_ID" "$TLS_DIR"
VSCODE_TLS_KEY="$TLS_DIR/key.pem" VSCODE_TLS_CERT="$TLS_DIR/crt.pem" \
    /opt/openvscode-server/node /opt/vscode-tls-proxy.mjs &

# Optional --server-base-path for running behind a path-based reverse proxy
BASE_PATH_ARGS=()
if [ -n "$VSCODE_BASE_PATH" ]; then
    BASE_PATH_ARGS=(--server-base-path "$VSCODE_BASE_PATH")
fi

cd /workspace
exec gosu "$USER_NAME" env \
    VSCODE_GALLERY_SERVICE_URL="$VSCODE_GALLERY_SERVICE_URL" \
    VSCODE_GALLERY_ITEM_URL="$VSCODE_GALLERY_ITEM_URL" \
    /opt/openvscode-server/bin/openvscode-server \
    --host 0.0.0.0 \
    --port 9000 \
    --without-connection-token \
    "${BASE_PATH_ARGS[@]}" \
    --user-data-dir "$DATA_DIR/data" \
    --extensions-dir /opt/vscode-extensions \
    /workspace
