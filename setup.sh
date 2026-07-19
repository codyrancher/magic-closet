#!/bin/sh
# First-time setup: create .env from the example and fill in generated
# secrets (any empty *_PASSWORD= entry), so the very first
# `docker compose up -d` already has them. Safe to re-run — existing values
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

for key in $(grep -oE '^[A-Z_]*_(PASSWORD|SECRET)=$' .env | tr -d '='); do
  value=$(gen_password)
  sed -i "s/^${key}=$/${key}=${value}/" .env
  echo "generated ${key}"
done

echo "done — start everything with: docker compose up -d"
