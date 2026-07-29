# api

The control plane of a magic closet: a small Node HTTP server (`src/server.js`)
that discovers sidecars, starts/stops/deletes them via `docker compose`, exposes
it all over HTTP + the `mc` CLI, and serves the dashboard (`src/dashboard.html`).

> ⚠️ **Pure vibes.** `server.js` and `dashboard.html` are a fast prototype —
> not cleaned up or hardened yet. Once we've validated the whole thing is
> actually useful, we'll tidy up (split the monolith, tighten the dashboard).
> Until then, expect rough edges.

- `src/server.js` — API + sidecar discovery/lifecycle + dashboard host
- `src/dashboard.html` — the single-file dashboard UI
- `tests/` — integration tests (boot the real server with docker + fetch mocked)
- `Dockerfile` — the `magic-closet-api` image
