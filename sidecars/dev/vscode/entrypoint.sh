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

# Node: install the requested version (falls back to the baked-in v24 when
# offline) and expose it everywhere — symlinks for non-shell contexts, fnm
# shell integration for terminals.
NODE_VERSION=${NODE_VERSION:-24}
export FNM_DIR=/opt/fnm
fnm install "$NODE_VERSION" 2>/dev/null || echo "fnm: could not install $NODE_VERSION, using existing versions"
NODE_BIN=$(dirname "$(fnm exec --using="$NODE_VERSION" -- which node 2>/dev/null)" 2>/dev/null || true)
if [ -n "$NODE_BIN" ] && [ -d "$NODE_BIN" ]; then
    fnm exec --using="$NODE_VERSION" -- corepack enable 2>/dev/null || true
    for bin in node npm npx corepack yarn pnpm; do
        [ -e "$NODE_BIN/$bin" ] && ln -sf "$NODE_BIN/$bin" "/usr/local/bin/$bin"
    done
    echo "node $(node --version) active (fnm, NODE_VERSION=$NODE_VERSION)"
fi
if ! grep -q 'fnm env' /etc/bash.bashrc 2>/dev/null; then
    echo 'export FNM_DIR=/opt/fnm; command -v fnm >/dev/null && eval "$(fnm env)" 2>/dev/null' >> /etc/bash.bashrc
fi

# gh: authenticate git through gh when a token is present (gh itself reads
# GH_TOKEN from the environment)
if [ -n "$GH_TOKEN" ]; then
    gosu "$USER_NAME" env GH_TOKEN="$GH_TOKEN" gh auth setup-git 2>/dev/null || true
fi

# Server state (settings, sessions) persists in the vscode-data volume
DATA_DIR=/data/openvscode-server
USER_DIR="$DATA_DIR/data/User"
DEFAULTS=/opt/vscode-defaults

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
