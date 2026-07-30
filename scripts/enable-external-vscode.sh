#!/usr/bin/env bash
# Host-side helper: let VS Code's Dev Containers see and attach the NESTED
# magic-closet containers (workspace-1, api, ...). Run this on the machine that
# hosts VS Code + Docker, AFTER bringing the closet up with the inner daemon
# exposed:
#
#     MC_EXTERNAL_VSCODE=1 docker compose up -d
#     ./scripts/enable-external-vscode.sh
#
# then reload the VS Code window and use
# "Dev Containers: Attach to Running Container" -> magic-closet-workspace-1.
#
# Why host-side and not the container template: dev.containers.dockerPath is read
# by VS Code on the HOST when it enumerates containers to attach — before any
# container is opened — so it can't come from inside a container. It's also a
# machine-scoped setting VS Code ignores in workspace settings. This script:
#   1. drops a `docker-inner` wrapper pointed at the exposed inner socket, and
#   2. sets dev.containers.dockerPath (machine scope) to that wrapper — so ONLY
#      the extension uses the inner daemon; your normal docker/compose are
#      untouched.
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
sock="$(cd "$repo_dir/.." && pwd)/instance/magic-closet/inner-docker.sock"

if [ ! -S "$sock" ]; then
  echo "Inner docker socket not found at: $sock" >&2
  echo "Bring the closet up with MC_EXTERNAL_VSCODE=1 first, then re-run." >&2
  exit 1
fi

wrapper=/usr/local/bin/docker-inner
sudo tee "$wrapper" >/dev/null <<EOF
#!/bin/sh
# Used only by VS Code (dev.containers.dockerPath) so the Dev Containers
# extension talks to the nested magic-closet daemon. Managed by
# scripts/enable-external-vscode.sh.
exec docker -H "unix://$sock" "\$@"
EOF
sudo chmod +x "$wrapper"
echo "wrote $wrapper -> $sock"

settings="$HOME/.vscode-server/data/Machine/settings.json"
mkdir -p "$(dirname "$settings")"
[ -s "$settings" ] || echo '{}' > "$settings"
python3 - "$settings" "$wrapper" <<'PY'
import json, sys
path, wrapper = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
d["dev.containers.dockerPath"] = wrapper
json.dump(d, open(path, "w"), indent=2)
PY
echo "set dev.containers.dockerPath -> $wrapper in $settings"
echo
echo "Done. Reload the VS Code window (Developer: Reload Window), then:"
echo "  Dev Containers: Attach to Running Container -> magic-closet-workspace-1"
