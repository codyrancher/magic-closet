#!/bin/bash
# PID 1 of the single privileged "magic-closet" container. This ONE container is
# now the docker-in-docker HOST, the workspace dev environment, AND the
# control-plane api. It boots an inner dockerd, sets up the workspace (node user,
# /workspace, shared toolchain, claude), brings up the nested SIDECARS
# (compose.stack.yml), and runs the api. Only the sidecars are nested now.
set -u

cd /magic-closet
export PWD=/magic-closet
: "${MC_DATA_DIR:=/magic-closet-data}"
export MC_DATA_DIR

# Note: nested Rancher/k3s needs the cgroup v2 **memory** controller. A private
# cgroup namespace doesn't get it delegated on this kernel, so the container runs
# in the HOST cgroup namespace (`cgroup: host` in docker-compose.yml), where the
# host already delegates memory down to the container's scope. Nothing to set up
# here — enabling controllers from inside a host cgroup ns would touch the host.

# ---------------------------------------------------------------------------
# 1. Inner dockerd (hosts the nested sidecars) — data-root lives in the single
#    persisted data volume (docker/), alongside workspace/, toolchain/, etc.
# ---------------------------------------------------------------------------
mkdir -p "$MC_DATA_DIR/docker"
dockerd --data-root "$MC_DATA_DIR/docker" >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!
echo "[mc] waiting for inner dockerd..."
tries=0
until docker info >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "[mc] inner dockerd did not become ready; last log:"
    tail -n 30 /var/log/dockerd.log 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "[mc] inner dockerd ready"

# ---------------------------------------------------------------------------
# 2. First-boot .env, derived ports, generated secrets
# ---------------------------------------------------------------------------
[ -f .env ] || sh ./setup.sh

base=$(grep -E '^API_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | sed 's/#.*//' | tr -d '[:space:]')
: "${base:=8300}"
export API_PORT="$base"
for pair in API_HTTPS_PORT:1 DEV_PORT:5 RANCHER_BROWSER_PORT:20 KEYCLOAK_PORT:30 OPENLDAP_PORT:40 RANCHER_PORT:44 FIGMA_PORT:60; do
  var=${pair%:*}; off=${pair#*:}
  grep -qE "^${var}=" .env 2>/dev/null || export "${var}=$((base + off))"
done

mkdir -p "$MC_DATA_DIR/.state"
SECRETS_FILE="$MC_DATA_DIR/.state/secrets.env"
[ -f "$SECRETS_FILE" ] || : > "$SECRETS_FILE"
set -a; . "$SECRETS_FILE"; set +a
for key in $(for f in workspace/sidecars/*/sidecar.yml workspace/sidecars/*/*/sidecar.yml; do
    [ -f "$f" ] || continue
    # Extract the items under the YAML `secrets:` list (stop at the next
    # top-level key), then isolate the *_PASSWORD/*_SECRET token from each —
    # scoped so `$..._PASSWORD` references elsewhere (e.g. notes) aren't picked up.
    awk '/^secrets:[[:space:]]*$/{s=1;next} /^[^[:space:]#-]/{s=0} s&&/^[[:space:]]*-/{print}' "$f" \
      | grep -oE '[A-Z0-9_]+_(PASSWORD|SECRET)'
  done | sort -u); do
  eval "cur=\${$key:-}"
  [ -n "$cur" ] && continue
  val=$(tr -dc 'a-zA-Z0-9@#%^*_+=-' < /dev/urandom | head -c 15)
  echo "${key}=${val}" >> "$SECRETS_FILE"
  export "${key}=${val}"
  echo "[mc] generated secret ${key}"
done

# ---------------------------------------------------------------------------
# 3. Workspace environment (node user, shared dirs, toolchain, claude)
# ---------------------------------------------------------------------------
USER_ID=${PUID:-1000}
GROUP_ID=${PGID:-1000}
# node:22 ships a "node" user at uid 1000 — reuse whatever owns the requested uid.
if ! getent group "$GROUP_ID" >/dev/null 2>&1; then groupadd -g "$GROUP_ID" dev; fi
if ! getent passwd "$USER_ID" >/dev/null 2>&1; then useradd -m -u "$USER_ID" -g "$GROUP_ID" -s /bin/bash dev; fi
USER_NAME=$(getent passwd "$USER_ID" | cut -d: -f1)
HOME_DIR=$(getent passwd "$USER_ID" | cut -d: -f6)
mkdir -p "$HOME_DIR"; chown "$USER_ID:$GROUP_ID" "$HOME_DIR"

# /shared -> the repo's shared dir (tools/bin/mc etc.; on PATH via /shared/tools/bin)
ln -sfn /magic-closet/workspace/shared /shared

# Shared Claude creds under the persisted data dir (claude-data/)
CLAUDE_DIR="$MC_DATA_DIR/claude-data"
mkdir -p "$CLAUDE_DIR"; chown "$USER_ID:$GROUP_ID" "$CLAUDE_DIR"
ln -sfn "$CLAUDE_DIR" "$HOME_DIR/.claude"
# Seed a valid empty JSON doc — an empty file makes claude report the config corrupted.
[ -s "$CLAUDE_DIR/.claude.json" ] || printf '{}\n' > "$CLAUDE_DIR/.claude.json"
chown "$USER_ID:$GROUP_ID" "$CLAUDE_DIR/.claude.json"
ln -sfn "$CLAUDE_DIR/.claude.json" "$HOME_DIR/.claude.json"

# Publish the heavyweight CLIs into the shared tools bin so sidecars get them too.
TOOLS_BIN=/shared/tools/bin
mkdir -p "$TOOLS_BIN"
cp -f /usr/local/bin/claude "$TOOLS_BIN/claude" 2>/dev/null || true
cp -f "$(command -v gh)" "$TOOLS_BIN/gh" 2>/dev/null || true
chmod -R a+rx "$TOOLS_BIN" 2>/dev/null || true

# tmux config + persistent claude session wrapper
cat > "$HOME_DIR/.tmux.conf" <<'TMUXCONF'
set -g mouse on
set -g history-limit 50000
TMUXCONF
chown "$USER_ID:$GROUP_ID" "$HOME_DIR/.tmux.conf"
cat > /usr/local/bin/claude-session <<'WRAPPER'
#!/bin/bash
SESSION_NAME="claude"
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    exec tmux attach-session -t "$SESSION_NAME"
fi
exec tmux new-session -s "$SESSION_NAME" -c /workspace bash -c '
    while true; do
        claude --continue --dangerously-skip-permissions 2>/dev/null || \
        claude --dangerously-skip-permissions
        echo ""; echo "Claude exited. Press Enter to restart or Ctrl+C to exit..."; read -t 5 || true
    done'
WRAPPER
chmod +x /usr/local/bin/claude-session

# /workspace -> the persisted workspace dir under the data mount (workspace/).
# Seed the template scaffold (CLAUDE.md, ...).
mkdir -p "$MC_DATA_DIR/workspace"
ln -sfn "$MC_DATA_DIR/workspace" /workspace
chown "$USER_ID:$GROUP_ID" "$MC_DATA_DIR/workspace"
if [ -d /magic-closet/workspace/template ]; then
  cp -rn /magic-closet/workspace/template/. /workspace/ 2>/dev/null || true
  chown -R "$USER_ID:$GROUP_ID" "$MC_DATA_DIR/workspace" 2>/dev/null || true
fi

# Shared node toolchain (nvm) under the persisted data dir (toolchain/).
# rm any pre-existing /opt/toolchain dir first, else `ln` nests the link inside it.
rm -rf /opt/toolchain
mkdir -p "$MC_DATA_DIR/toolchain"; chown -R "$USER_ID:$GROUP_ID" "$MC_DATA_DIR/toolchain"
ln -sfn "$MC_DATA_DIR/toolchain" /opt/toolchain
gosu "$USER_NAME" env NVM_DIR=/opt/toolchain/nvm HOME="$HOME_DIR" bash /magic-closet/workspace/setup-node.sh || true
( until [ -f /workspace/dashboard/.nvmrc ]; do sleep 3; done
  gosu "$USER_NAME" env NVM_DIR=/opt/toolchain/nvm HOME="$HOME_DIR" bash /magic-closet/workspace/setup-node.sh || true ) &

# Expose .env params + generated secrets to interactive shells (claude/git/gh/mc)
# via a login profile — the same effect the old workspace container got from its
# compose env_file. Point `mc` at the local api.
python3 - "$SECRETS_FILE" > /etc/profile.d/mc-env.sh <<'PY'
import shlex, re, sys
def load(p):
    d = {}
    try:
        for ln in open(p):
            s = ln.strip()
            if not s or s.startswith('#') or '=' not in s:
                continue
            k, v = s.split('=', 1)
            d[k.strip()] = re.sub(r'\s+#.*$', '', v).strip()
    except FileNotFoundError:
        pass
    return d
env = {}
env.update(load('/magic-closet/.env'))
env.update(load(sys.argv[1]))
env['MC_API_URL'] = 'http://localhost:%s' % (env.get('API_PORT') or '8300')
for k, v in env.items():
    print('export %s=%s' % (k, shlex.quote(v)))
PY
chmod 0644 /etc/profile.d/mc-env.sh

# Optional per-workspace init hook
if [ -f /workspace/init.sh ]; then
  chmod +x /workspace/init.sh
  gosu "$USER_NAME" bash -c '/workspace/init.sh > /workspace/.init.log 2>&1' &
fi

# ---------------------------------------------------------------------------
# 4. Bring up the nested SIDECARS (workspace + api are no longer nested)
# ---------------------------------------------------------------------------
echo "[mc] bringing up sidecars (first run builds images)..."
docker compose -f compose.stack.yml up -d --build \
  || echo "[mc] 'compose up' returned non-zero — check 'docker compose logs'"

# ---------------------------------------------------------------------------
# 5. Control-plane api (runs in THIS container now; supervised — restart on exit)
# ---------------------------------------------------------------------------
export MC_ROOT=/magic-closet
export MC_PROJECT="${MC_PROJECT:-magic-closet}"
export MC_ENV_FILE="${MC_ENV_FILE:-.env}"
export MC_COMPOSE_FILE="${MC_COMPOSE_FILE:-compose.stack.yml}"
export MC_API_PORT="$API_PORT"
export MC_API_HTTPS_PORT="${API_HTTPS_PORT:-$((API_PORT + 1))}"
# The api needs js-yaml (sidecar.yml). node_modules is gitignored, so link the
# baked deps next to the api unless the mounted repo already carries its own.
if [ ! -e /magic-closet/workspace/api/node_modules ] && [ -d /opt/api-deps/node_modules ]; then
  ln -s /opt/api-deps/node_modules /magic-closet/workspace/api/node_modules 2>/dev/null || true
fi
( while true; do
    echo "[mc] starting api (http :$MC_API_PORT / https :$MC_API_HTTPS_PORT)"
    node /magic-closet/workspace/api/src/server.js
    echo "[mc] api exited ($?); restarting in 2s"
    sleep 2
  done ) >>/var/log/mc-api.log 2>&1 &

echo "[mc] up. Nested sidecars:"
docker ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null || true
echo "[mc] holding on inner dockerd (container stays up; 'docker compose down' on the host stops it)"

# Container lifetime = inner dockerd lifetime.
wait "$DOCKERD_PID"
