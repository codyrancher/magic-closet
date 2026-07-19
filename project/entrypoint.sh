#!/bin/bash
set -e

USER_ID=${PUID:-1000}
GROUP_ID=${PGID:-1000}

# node:22 ships a "node" user at 1000 — reuse whatever owns the requested UID
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

# Persist Claude credentials/config in the claude-data volume (shared with
# the vscode sidecar so both use the same login session)
if [ -d /claude-data ]; then
    chown "$USER_ID:$GROUP_ID" /claude-data
    ln -sfn /claude-data "$HOME_DIR/.claude"
    [ -f /claude-data/.claude.json ] || touch /claude-data/.claude.json
    chown "$USER_ID:$GROUP_ID" /claude-data/.claude.json
    ln -sfn /claude-data/.claude.json "$HOME_DIR/.claude.json"
fi

# Publish the heavyweight CLIs into the shared tools mount so every sidecar
# that mounts /opt/magic-closet/tools gets them too.
TOOLS_BIN=/opt/magic-closet/tools/bin
if [ -d "$(dirname "$TOOLS_BIN")" ]; then
    mkdir -p "$TOOLS_BIN"
    cp -f /usr/local/bin/claude "$TOOLS_BIN/claude" 2>/dev/null || true
    cp -f "$(command -v gh)" "$TOOLS_BIN/gh" 2>/dev/null || true
    chmod -R a+rx "$TOOLS_BIN"
fi

# tmux config: mouse scrolling + big scrollback
cat > "$HOME_DIR/.tmux.conf" << 'TMUXCONF'
set -g mouse on
set -g history-limit 50000
TMUXCONF
chown "$USER_ID:$GROUP_ID" "$HOME_DIR/.tmux.conf"

# Persistent Claude session: attach if running, otherwise start in /workspace
cat > /usr/local/bin/claude-session << 'WRAPPER'
#!/bin/bash
SESSION_NAME="claude"
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    exec tmux attach-session -t "$SESSION_NAME"
fi
exec tmux new-session -s "$SESSION_NAME" -c /workspace bash -c '
    while true; do
        claude --continue --dangerously-skip-permissions 2>/dev/null || \
        claude --dangerously-skip-permissions
        echo ""
        echo "Claude exited. Press Enter to restart or Ctrl+C to exit..."
        read -t 5 || true
    done
'
WRAPPER
chmod +x /usr/local/bin/claude-session

chown "$USER_ID:$GROUP_ID" /workspace

# Optional per-project init hook
if [ -f /workspace/init.sh ]; then
    chmod +x /workspace/init.sh
    gosu "$USER_NAME" bash -c '/workspace/init.sh > /workspace/.init.log 2>&1' &
fi

echo "magic-closet project container ready (user: $USER_NAME)"
exec gosu "$USER_NAME" sleep infinity
