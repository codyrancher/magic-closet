# magic closet

A dev environment as a closet of optional containers: one **project**
container with the source code and node, plus opt-in **sidecars** (VS Code,
Chromium, Rancher, Figma MCP) each in its own directory, plus a small API to
start/stop/delete them at runtime.

```bash
./setup.sh             # first time only — creates .env and generates secrets
docker compose up -d   # starts project + api + the sidecars in COMPOSE_PROFILES
```

Then:
- VS Code: http://localhost:8310
- Rancher browser (Chromium): https://localhost:8320 (self-signed cert)
- Rancher: https://localhost:8444
- Dashboard + control API: http://localhost:8300

See [CLAUDE.md](CLAUDE.md) for the full configuration guide (ports, profiles,
sidecar parameters, adding sidecars, the `mc` CLI, the Rancher UI extension).
