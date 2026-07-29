#!/bin/sh
# Runs as PID 1 of the single "magic-closet" DinD container (see
# docker-compose.yml). Boots an inner dockerd, then brings up the whole stack
# (compose.stack.yml) inside this container so nothing lands on the host docker.
set -u

# The compose interpolation in compose.stack.yml uses ${PWD} for MC_ROOT and the
# repo bind mount — make sure it resolves to the in-container repo path.
cd /magic-closet
export PWD=/magic-closet

# Start the dind image's own dockerd (backgrounded) and wait for the socket.
dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
echo "[dind] waiting for inner dockerd..."
tries=0
until docker info >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "[dind] inner dockerd did not become ready; last log:"
    tail -n 30 /var/log/dockerd.log 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "[dind] inner dockerd ready"

# The compose plugin isn't bundled in every dind image — ensure it's present.
docker compose version >/dev/null 2>&1 || apk add --no-cache docker-cli-compose >/dev/null 2>&1

# First boot with no .env: generate one (secrets + defaults). Normally the
# bind-mounted repo already has .env, so this is skipped.
[ -f .env ] || sh ./setup.sh

# Derive every sidecar host port from API_PORT (default 8300) for any not
# explicitly set in .env, and export them so the inner compose interpolates
# them. Anything set in .env wins (we don't override it). So .env only needs
# API_PORT; add a *_PORT line to override an individual one.
base=$(grep -E '^API_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | sed 's/#.*//' | tr -d '[:space:]')
: "${base:=8300}"
export API_PORT="$base"
for pair in API_HTTPS_PORT:1 DEV_PORT:5 VSCODE_PORT:10 RANCHER_BROWSER_PORT:20 KEYCLOAK_PORT:30 OPENLDAP_PORT:40 RANCHER_PORT:44 FIGMA_PORT:60; do
  var=${pair%:*}; off=${pair#*:}
  grep -qE "^${var}=" .env 2>/dev/null || export "${var}=$((base + off))"
done

# Generate login secrets (Rancher/Keycloak/OpenLDAP admin + user passwords)
# into a gitignored runtime file — NOT .env, which stays human-authored. Every
# env var listed in a sidecar's "secrets" array is generated here once and
# reused on later boots: rancher/keycloak persist their own copy in volumes, so
# regenerating each start would break login. Sourcing first, then exporting,
# lets the `compose up` below (and the api's --env-file) interpolate them.
# Runtime state lives under MC_DATA_DIR (a separate mount so it stays out of the
# source tree); defaults to the repo when unset. Export it so the inner
# `compose up` interpolates ${MC_DATA_DIR} for the api/closet mounts.
: "${MC_DATA_DIR:=/magic-closet}"
export MC_DATA_DIR
mkdir -p "$MC_DATA_DIR/.state"
SECRETS_FILE="$MC_DATA_DIR/.state/secrets.env"
[ -f "$SECRETS_FILE" ] || : > "$SECRETS_FILE"
set -a; . "$SECRETS_FILE"; set +a
for key in $(for f in closet/sidecars/*/sidecar.json closet/sidecars/*/*/sidecar.json; do
    [ -f "$f" ] || continue
    tr '\n' ' ' < "$f" | grep -oE '"secrets"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
      | grep -oE '[A-Z0-9_]+_(PASSWORD|SECRET)'
  done | sort -u); do
  eval "cur=\${$key:-}"
  [ -n "$cur" ] && continue
  val=$(tr -dc 'a-zA-Z0-9@#%^*_+=-' < /dev/urandom | head -c 15)
  echo "${key}=${val}" >> "$SECRETS_FILE"
  export "${key}=${val}"
  echo "[dind] generated secret ${key}"
done

echo "[dind] bringing up the magic-closet stack (first run builds images)..."
docker compose -f compose.stack.yml up -d --build \
  || echo "[dind] 'compose up' returned non-zero — check 'docker compose logs' inside the container"

echo "[dind] stack is up. Nested containers:"
docker ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null || true
echo "[dind] tailing inner dockerd (container stays up; 'docker compose down' on the host stops it)"

# Keep PID 1 alive by following dockerd.
wait
