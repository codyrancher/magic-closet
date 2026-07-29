# magic closet

A dev environment as a closet of optional containers — one **workspace** container
(your source + node) plus opt-in **sidecars** (VS Code, a Chromium browser,
Rancher, Keycloak, ...), all managed from a small dashboard. The whole stack
runs inside a single Docker-in-Docker container, so nothing but that one
container lands on your host.

## Start

Requires Docker. From this directory:

```bash
docker compose up -d
```

The first run creates `.env`, generates secrets, and builds the stack inside the
container (give it a few minutes — watch with `docker compose logs -f`). Then
open the dashboard:

**http://localhost:8300**

Start/stop sidecars and open them (VS Code, Rancher, ...) from there. To
customize first — ports, tokens, or which sidecars start — copy `.env.example`
to `.env` and edit before running.

## Everyday commands

```bash
docker compose logs -f            # boot + build progress
docker exec -it magic-closet sh   # shell inside; `docker ps` shows the sidecars
docker compose down               # stop (nested data kept)
docker compose down -v            # stop + wipe all nested data
```

See [CLAUDE.md](CLAUDE.md) for the full guide — ports, profiles, sidecar
parameters, adding sidecars, the `mc` CLI, and the Rancher UI extension.
