#!/bin/sh
# First-time setup: create .env from the example and generate every login/
# bootstrap secret so the very first `docker compose up -d` already has them.
# Secrets are never authored by hand — they're discovered from each sidecar's
# "secrets" array (sidecars/*/sidecar.json). Safe to re-run — existing values
# are never touched.
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example"
fi

gen_password() {
  # Same shape as the api's generator: 15 chars, mixed classes
  # ('&' omitted — it's special in the sed replacement below)
  tr -dc 'a-zA-Z0-9@#%^*_+=-' < /dev/urandom | head -c 15
}

# Every env var listed in a sidecar.json "secrets": [ ... ] array (handles both
# single-line and multi-line arrays).
secret_keys() {
  for f in sidecars/*/sidecar.json sidecars/*/*/sidecar.json; do
    [ -f "$f" ] || continue
    tr '\n' ' ' < "$f" \
      | grep -oE '"secrets"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
      | grep -oE '[A-Z0-9_]+_(PASSWORD|SECRET)'
  done | sort -u
}

for key in $(secret_keys); do
  if grep -qE "^${key}=." .env; then
    continue                      # already has a value — leave it
  fi
  value=$(gen_password)
  if grep -qE "^${key}=$" .env; then
    sed -i "s/^${key}=$/${key}=${value}/" .env   # fill an empty line
  else
    echo "${key}=${value}" >> .env               # or append a fresh one
  fi
  echo "generated ${key}"
done

echo "done — start everything with: docker compose up -d"
