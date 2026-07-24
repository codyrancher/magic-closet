#!/bin/sh
# First-time setup: create .env from the example. Generated login secrets are
# NOT written here — the dind-entrypoint generates them at init into the
# gitignored .state/secrets.env (kept out of the human-authored .env). Safe to
# re-run — an existing .env is left untouched.
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example"
fi

echo "done — start everything with: docker compose up -d"
