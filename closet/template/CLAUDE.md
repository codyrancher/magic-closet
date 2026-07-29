# Working inside a magic closet

You are an agent running **inside a magic closet dev environment** — a project
container with the source under `/workspace`, plus a set of optional **sidecar**
containers (Rancher, a browser, Keycloak, OpenLDAP, Figma, …) you can drive.
This file tells you what's available and how to use it. (Details of a specific
checked-out repo live in its own `CLAUDE.md`, e.g. `/workspace/dashboard`.)

## The control API and the `mc` CLI

A control API manages the sidecars. Reach it at `http://api:8080` from any
container (the `mc` CLI wraps it and is already on your `PATH`):

```bash
mc list                       # sidecars + status, host ports, params (JSON)
mc start rancher tag=v2.11-head --wait   # start/restart a sidecar (params are k=v)
mc stop rancher-browser       # stop (kept for fast restart)
mc rm figma                   # stop + remove the container (named volumes kept)
mc run "yarn install"         # run a command in the closet container
mc open https://rancher       # open a tab in the rancher-browser sidecar
```

Raw endpoints (same thing) — `http://api:8080`:

| Method + path | Purpose |
|---|---|
| `GET /sidecars` | list: status, health, host port, params + values, `internal` URL |
| `POST /sidecars/<name>/start` | body `{ "params": {...}, "wait": true }` |
| `POST /sidecars/<name>/stop` / `DELETE /sidecars/<name>` | stop / remove |
| `POST /exec` | `{ "command": "yarn build" }` → runs in the closet container |
| `POST /browser/open` | `{ "url": "https://rancher" }` → queue a tab in the browser |
| `POST /auth/apply` | `{ "provider": "keycloak" }` → set Rancher's auth provider |

Params/secrets are **global**: everything in `.env` is loaded as env vars into
every container, so credentials are already in your environment (see below) and
a value set for one sidecar is visible to all.

## Sidecars

Service names resolve on the shared network (`https://rancher`,
`http://api:8080`, …). `mc list` shows which are running.

- **rancher** (`https://rancher`, host `:${RANCHER_PORT}` = 8444) — Rancher
  server. Log in as `admin` / `$RANCHER_BOOTSTRAP_PASSWORD` (local), or
  `user1`..`user3` / `$RANCHER_USER1_PASSWORD`.. . First boot takes several
  minutes. **OIDC/LDAP logins and any `https://rancher` URL only resolve inside
  the network — drive them through the rancher-browser sidecar, not a host
  browser.**
- **rancher-browser** — Chromium with a Rancher quick-login bar + a Ctrl+M
  command menu. Open tabs with `mc open <url>`. For automation, get the CDP
  endpoint with `cdp-url` and connect Playwright:
  `node -e '...chromium.connectOverCDP(process.argv[1])...' "$(cdp-url)"`.
- **keycloak** (`http://keycloak:8080`, host `:${KEYCLOAK_PORT}` = 8330) —
  OIDC/SAML provider. Realm `rancher`, client `rancher` /
  `$KEYCLOAK_CLIENT_SECRET`, users `user1`..`user3`. Admin console: `admin` /
  `$KEYCLOAK_ADMIN_PASSWORD`. Wire it into Rancher with
  `mc ... ` → `POST /auth/apply {"provider":"keycloak"}` (or `keycloak-saml`).
- **openldap** (`ldap://openldap:389`, host `:${OPENLDAP_PORT}` = 8340) — LDAP
  directory. Base DN `dc=magic-closet,dc=local`; directory admin
  `cn=admin,dc=magic-closet,dc=local` / `$OPENLDAP_ADMIN_PASSWORD`. Login users
  under `ou=users`: `admin`, `user1`..`user3` (each password = its Rancher
  password). Apply to Rancher with `{"provider":"openldap"}`.
- **vscode** — the editor you're likely viewing (`/workspace`).
- **figma** (`http://figma:8000`) — Figma MCP server; needs `$FIGMA_API_KEY`.

Auth note: Rancher allows **one** external auth provider at a time; `POST
/auth/apply` disables the others. Logging into Rancher via Keycloak/OpenLDAP
authenticates as a regular user — for the global admin use "Use a local user"
with `admin` / `$RANCHER_BOOTSTRAP_PASSWORD`.

## Creating and editing sidecars

You can define new sidecars — or override built-in ones — from inside the
closet. They persist and are inherited by every future compose closet.

```bash
# simple: an image, optionally publishing a container port
mc create-sidecar postgres image=postgres:16 group=data \
  containerPort=5432 port=POSTGRES_PORT description="Postgres 16"
# full control: a JSON spec (params, secrets, environment, raw compose overrides)
mc create-sidecar myapp --file /workspace/myapp-sidecar.json
mc edit-sidecar postgres image=postgres:17   # edit (built-ins too — writes a shadowing override)
mc rm-sidecar postgres                        # remove a custom definition (built-in reverts)
mc list && mc start postgres --wait           # discoverable + startable immediately
```

Spec fields: `name` (required, `[a-z0-9-]`), `image` (or raw `compose`
overrides), `description`, `group`, `containerPort`, `port` (`.env` var for the
host port) / `hostPort`, `scheme`, `environment` {k:v}, `params[]`, `secrets[]`
(auto-generated). Definitions land in `custom-sidecars/<name>/` under the repo
root. Same thing over HTTP: `POST /sidecars`, `PUT /sidecars/<name>`,
`DELETE /sidecars/<name>/definition`.

Reachability: a custom sidecar is always reachable in-network by service name
(`http://<name>:<port>`); from the **host** only if its published port lands in
the DinD wrapper's range (`8500-8519`). Most sidecars (a DB/tool the project
talks to) need no host port.

## The workspace

- `/workspace` is bind-mounted and shared with the vscode sidecar. A target
  repo is cloned into **`/workspace/dashboard`** (rancher/dashboard master by
  default; set the vscode `githubUrl` param to a PR/issue to check that out).
- **Dev server:** listen on `0.0.0.0:8005` inside this container — it's
  published to the host as `:${DEV_PORT}` (8305). For rancher/dashboard:
  `cd /workspace/dashboard && yarn install && API=https://rancher yarn dev`
  (Vite serves on 8005). Reach the running Rancher at `https://rancher`.
- `git` and the `gh` CLI are authenticated from `$GH_TOKEN` when it's set.

## Credentials quick reference

All are env vars in this container (values generated at setup, stored in `.env`):

| Env var | Used for |
|---|---|
| `RANCHER_BOOTSTRAP_PASSWORD` | Rancher local `admin` (also LDAP `admin`) |
| `RANCHER_USER1_PASSWORD` … `RANCHER_USER3_PASSWORD` | Rancher/Keycloak/LDAP `user1..3` |
| `KEYCLOAK_ADMIN_PASSWORD` | Keycloak admin console |
| `KEYCLOAK_CLIENT_SECRET` | Keycloak OIDC client `rancher` |
| `OPENLDAP_ADMIN_PASSWORD` | LDAP directory admin (`cn=admin`) |
| `GH_TOKEN` | `gh`/`git` auth |
| `FIGMA_API_KEY` | Figma MCP sidecar |
