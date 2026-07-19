# magic closet

A project development environment built from small, optional pieces. One main
container holds the source code and node; everything else (VS Code, a browser,
Rancher, MCP servers, ...) is a **sidecar** — an independent, optional
container with its own directory under `sidecars/`.

Start everything with a single command from this directory:

```bash
docker compose up -d
```

Which sidecars that command starts is controlled by `COMPOSE_PROFILES` in
`.env` (run `./setup.sh` once first — it creates `.env` from the example and
fills in generated secrets).

## Layout

```
magic-closet/
├── docker-compose.yml   # core services (project, api) + include: of each sidecar
├── .env                 # profiles, host ports, sidecar parameters
├── workspace/           # THE source code — bind-mounted into project + vscode
├── tools/               # shared CLI tools, mounted into every container
│   └── bin/mc           # control CLI (list/start/stop/rm/run)
├── project/             # main container image (node, git, gh, claude)
├── api/                 # sidecar control API (port ${API_PORT}, default 8300)
└── sidecars/
    └── <name>/          # one directory per sidecar
        ├── compose.yml  # its service definition (compose fragment)
        ├── sidecar.json # metadata: description, params, port var
        └── ...          # Dockerfile / entrypoint / config if it builds an image
```

## Editing the configuration

### Change a host port
Edit the `*_PORT` value in `.env`, then `docker compose up -d`. That's the
entire port-forwarding mechanism — a plain compose `ports:` mapping driven by
one env var per service. No proxy or forwarder containers.

### Make a sidecar start (or not start) by default
Add/remove its name in `COMPOSE_PROFILES` in `.env`. Every sidecar is
optional: a sidecar not in the list simply doesn't start with
`docker compose up -d`, but can still be started on demand (see API below).

### Change a sidecar's settings
Edit `sidecars/<name>/compose.yml`. It's a normal compose file; the only
conventions are:

1. `profiles: ["<name>"]` — keeps the sidecar optional (profile = dir name).
2. No `container_name` — compose names containers per project, and the API
   finds them via compose labels (required for multiple closets).
3. Paths are relative to the **repo root** (the include uses
   `project_directory: .`), e.g. `./workspace`, `./tools`, `./sidecars/<name>/...`.
4. Tunables are exposed as env vars with defaults (`${RANCHER_TAG:-head}`) and
   declared in `sidecar.json` so the API can set them.

### Sidecar groups
A directory under `sidecars/` **without** a `compose.yml` is a group; its
subdirectories are sidecars (e.g. `sidecars/auth/keycloak`,
`sidecars/auth/openldap`). The dashboard renders each group as a titled
section; the API reports the group on each sidecar. Profile and service
names stay flat (`keycloak`) — the group is purely organizational.

### Add a new sidecar
1. `mkdir sidecars/<name>` (or `sidecars/<group>/<name>`) with a `compose.yml`
   (follow the conventions above) and a `sidecar.json`:
   ```json
   {
     "name": "<name>",
     "description": "what it does",
     "port": "MYTHING_PORT",            // optional: .env var of its host port
     "params": [
       { "id": "tag", "env": "MYTHING_TAG", "default": "latest",
         "description": "image tag" }
     ]
   }
   ```

   A param may set `"group": "AWS"` — the dashboard renders each group as a
   collapsible accordion section on the card (see the rancher-browser sidecar’s AppCo
   and AWS groups); ungrouped params show as flat rows.

   Internal secrets are not params — list their env vars in a top-level
   `"secrets"` array instead (see rancher's `RANCHER_BOOTSTRAP_PASSWORD`).
   They never appear in the dashboard or the start API; the api generates a
   password and persists it to `.env` at boot and before any start. Name them
   `*_PASSWORD` so `setup.sh` also fills them when seeding a fresh `.env`
   (that matters because a first `docker compose up -d` creates sidecar
   containers before the api can write `.env`). Look the value up in `.env`
   when you need to log in.
2. Add it to the `include:` list in `docker-compose.yml`.
3. Optionally add its profile to `COMPOSE_PROFILES` and its port/params to
   `.env` / `.env.example`.

The API discovers sidecars by scanning `sidecars/*/sidecar.json` — no code
changes needed.

A param can also declare a suggested-values source; the dashboard then renders
it as a taggable dropdown (suggestions + free text) and the API serves them at
`GET /sidecars/<name>/params/<id>/options`. Currently supported source —
Docker Hub image tags (see the rancher `tag` param):

```json
"options": {
  "source": "dockerhub",
  "repo": "rancher/rancher",     // image to list tags for
  "filter": "head",              // server-side name filter (contains)
  "pattern": "^v2\\.\\d+-head$", // keep only matching tags
  "nextMinor": true,             // also suggest one minor past the newest (v2.15-head -> v2.16-head)
  "prepend": ["head"]            // fixed values, listed first
}
```

A second source, `github-node-engines`, lists the node major versions a
GitHub repo's branches declare in `package.json` `engines.node` (see the
vscode `nodeVersion` param — main branch's version first, then the last
`limit` `branchPrefix` branches):

```json
"options": { "source": "github-node-engines", "repo": "rancher/dashboard",
             "mainBranch": "master", "branchPrefix": "release-2.", "limit": 6 }
```

A param with `"defaultFromOptions": true` gets its default from the first
option: when its env var is unset in `.env`, the api resolves the options and
persists option[0] (e.g. `NODE_VERSION` = whatever rancher/dashboard:master
uses) — at boot and before any start.

Results are cached for 10 minutes; if the upstream (Docker Hub / GitHub) is
unreachable the endpoint falls back to the `prepend` values.

### Remove a sidecar
Delete its directory and its `include:` entry, and drop its profile from
`COMPOSE_PROFILES`.

## The control API

`api/` runs alongside the project container (it is core, not a sidecar) and
drives `docker compose` through the host docker socket.

```
GET    /                        dashboard: sidecar cards with status, params, start/stop/delete
GET    /sidecars                list sidecars: status, health, host port, params + current values
POST   /sidecars/<name>/start   body: { "params": {"tag": "v2.11-head"}, "wait": true }
POST   /sidecars/<name>/stop    stop the container (kept for fast restart)
DELETE /sidecars/<name>         stop + remove the container (named volumes kept)
POST   /project/exec            { "command": "yarn build" } → runs in the project container
POST   /browser/open            { "url": "https://rancher" } → open a tab in the rancher-browser
                                sidecar; 202 + queued if the browser isn't ready, and the
                                queue is flushed (FIFO) once it comes up
GET    /browser/queue           tabs still waiting for the browser
```

- `start` params are validated against `sidecar.json` and **persisted to
  `.env`**, so a later `docker compose up -d` keeps them.
- **All params and secrets are global**: every container (project + every
  sidecar) loads `.env` via `env_file`, so an argument passed for one sidecar
  is readable as an env var in all of them (e.g. `RANCHER_TAG`,
  `RANCHER_BOOTSTRAP_PASSWORD`). A container picks up changed values the next
  time it is recreated — starting a sidecar through the API does that for the
  sidecar itself; others follow on their next `docker compose up -d`.
- `"wait": true` blocks until the container is healthy (uses the compose
  healthcheck if the sidecar defines one).
- From the host: `http://localhost:${API_PORT}` (default 8300) or
  `https://localhost:${API_HTTPS_PORT}` (default 8301, self-signed — for
  https dashboards that would otherwise hit mixed-content blocking; every
  provisioned closet gets its own https port at base+1). From any container:
  `http://api:8080` / `https://api:8443`.

### The `mc` CLI
`tools/` is mounted into every container at `/opt/magic-closet/tools` (and on
PATH in the images we build), so all sidecars share the same CLI tools —
including `claude` and `gh`, which the project container copies into
`tools/bin` at startup.

```bash
mc list                          # sidecars + status
mc start rancher tag=v2.11-head --wait
mc stop rancher-browser
mc rm figma
mc run "yarn install"            # executes inside the project container
mc open https://rancher          # open a browser tab (queued until the browser is up)
```

On the host, prefix with `MC_API_URL=http://localhost:8300`.

## Core services (not sidecars)

- **project** — holds `/workspace` (bind of `./workspace`), node 22, git, gh,
  claude. Long-running; get a shell with
  `docker exec -it -u 1000 magic-closet-project bash`, or `claude-session`
  inside it for a persistent tmux Claude session. Dev servers should listen on
  `0.0.0.0:8005` (forwarded as `${DEV_PORT}`). If `workspace/init.sh` exists
  it runs (backgrounded, log: `workspace/.init.log`) on container start.
- **api** — the control API above.

## Workspace code (GITHUB_URL)

The vscode sidecar's `githubUrl` param points at a GitHub PR, issue, or repo;
the api clones it into `/workspace/dashboard` (blob-less partial clone) via
the project container:

- `.../pull/123` — PR head checked out on branch `pr-123`
- `.../issues/456` — default branch on a new branch `issue-456`
- bare repo URL — default branch

VS Code opens `/workspace`; the clone is skipped while `/workspace/dashboard`
exists (delete it to re-clone). Log: `workspace/.clone.log`.

## Rancher bootstrap

Whenever the rancher sidecar comes up (started via the API, dashboard, or
plain `docker compose up` — a 30s watcher catches the latter), the api runs an
idempotent bootstrap once per container: waits for the rancher API, logs in
with `RANCHER_BOOTSTRAP_PASSWORD`, sets `first-login=false`, clears
`server-url`, sets `agent-tls-mode=system-store`, and creates standard users
`user1`-`user3` (passwords: `RANCHER_USER1_PASSWORD`… in `.env`, all
auto-generated). Progress is logged by the api container and surfaced as
`bootstrap: idle|running|done|failed` on the rancher entry in `GET /sidecars`.

## Auth sidecars (sidecars/auth/)

Rancher allows **one** enabled auth provider at a time. Each auth sidecar
card carries a **"rancher auth" row**: a mode dropdown (when the sidecar maps
to several Rancher providers — e.g. keycloak → OIDC or SAML) and an **Apply**
button that configures Rancher, disabling whichever provider was active
before. Apply is only enabled while both rancher and the sidecar are running;
the active provider shows as "Applied". Under the hood this is
`POST /auth/apply {"provider": "keycloak-saml"}`, which persists the choice
as `RANCHER_AUTH_PROVIDER` in `.env` so the bootstraps re-apply it after
restarts. Declared per sidecar in `sidecar.json`:

```json
"rancherAuth": { "modes": [{ "value": "keycloak", "label": "OIDC" },
                            { "value": "keycloak-saml", "label": "SAML" }] }
```

All auth sidecars get users `user1`-`user3` with the same passwords as the
Rancher local users, so the browser extension's quick-login works everywhere.

- **keycloak** — Keycloak (OIDC) (see below).
- **keycloak-saml** — Rancher's "Keycloak (SAML)" provider, backed by the
  *same* keycloak container: the bootstrap adds a SAML client (+ attribute
  mappers) to the realm, and the api generates an SP key/cert into
  `.state/saml/` (gitignored) for Rancher's SAML config.
- **openldap** — LDAP directory (base DN `dc=magic-closet,dc=local`, admin
  `cn=admin,...` / `OPENLDAP_ADMIN_PASSWORD`). Rancher's login form
  authenticates against it directly, and the api verifies an actual LDAP
  login after connecting.
- **samba-ad** — Samba Active Directory DC (realm `SAMBA.MAGIC-CLOSET.LOCAL`,
  NetBIOS `SAMBA`, `Administrator` / `SAMBA_ADMIN_PASSWORD`), wired to
  Rancher's ActiveDirectory provider; the api verifies an AD login after
  connecting. `INSECURELDAP` allows Rancher's plain-LDAP binds.
- **freeipa** (EXPERIMENTAL) — FreeIPA server (realm `MAGIC-CLOSET.LOCAL`,
  admin + Directory Manager password `FREEIPA_ADMIN_PASSWORD`). First start
  runs `ipa-server-install` (~10 min). Known issue: on this host the install
  deterministically fails at the on-master client phase ("No valid Negotiate
  header" — ipa-client-install stops the shared gssproxy while calling the
  IPA API that needs it; reproduced on almalinux-9 and almalinux-9-4.12.2
  images, fresh volumes). The bootstrap (users via `ipa` CLI with
  password-expiry lifted, Rancher connect + verified login) is implemented
  and will complete automatically on any run where the install succeeds.

Rancher's remaining providers can't be sidecars: GitHub, Google, Entra ID,
Cognito, Okta, and Ping are external services; AD/ADFS are Windows.
Shibboleth would need a real Shibboleth IdP (its SAML code path is exercised
by keycloak-saml).

## Keycloak (OIDC)

The `keycloak` sidecar runs Keycloak in dev mode (http). When it comes up,
the api bootstraps it (idempotent, same triggers as the rancher bootstrap):
realm `rancher` with `sslRequired: none`, a confidential OIDC client
(`rancher` / `KEYCLOAK_CLIENT_SECRET`), and users `user1`-`user3` with the
same passwords as the Rancher local users. Whenever rancher AND keycloak are
both running, the api enables Rancher's **Keycloak (OIDC)** auth provider
against it (issuer `http://keycloak:8080/realms/rancher`, redirect
`https://rancher/verify-auth`) — the Rancher login page then defaults to
"Log in with OIDC". Keycloak admin console: http://localhost:${KEYCLOAK_PORT}
(admin / `KEYCLOAK_ADMIN_PASSWORD` in `.env`). The OIDC URLs use compose
network names, so log in through the rancher-browser sidecar (not a host
browser).

## Browser extension (Quick Login + command menu)

The rancher-browser sidecar loads an unpacked Chrome extension on Rancher pages
(`sidecars/dev/rancher-browser/extension/`): a Quick Login bar that autofills
admin/user1-3 credentials on the login page, and a Ctrl+M command menu (EC2
cluster creation, AppCo chart repo — the latter needs `APPCO_EMAIL` /
`APPCO_TOKEN`). Chrome only loads extensions at launch, so it lives in the
browser sidecar; credentials are NOT baked into the files — `ext-init`
(a `custom-cont-init.d` one-shot) renders `config.js` from the global env
into `/opt/autofill-ext` before chromium starts. After editing extension
files, recreate the rancher-browser sidecar to pick them up.

## Multiple closets

A **closet** is a full magic-closet deployment. The default one is compose
project `magic-closet` with `./.env`; the api doubles as a **controller**
that can provision more:

- `POST /closets {"name": "pr-123", "profiles": [...]}` — creates compose
  project `mc-pr-123` with its own env file
  (`.state/closets/pr-123.env`: allocated 100-port block from 8500 up,
  generated secrets, own workspace in `workspaces/<name>/`) and runs
  `docker compose -p mc-<name> --env-file ... up -d`. Each closet runs its
  own api (at `<base>+0`) managing its own sidecars.
- `GET /closets` — the local closet + all provisioned ones (+ `hostGateway`,
  the docker bridge IP viewers inside containers use to reach other closets'
  host ports).
- `DELETE /closets/<name>` — `compose down -v` + removes the env file
  (workspace kept).

No fixed `container_name`s anywhere (they would collide across closets) —
the api finds containers via compose labels. Images for built services carry
explicit tags (`magic-closet-api` etc.) so all closets share one build.

**Gotcha**: recreating a rancher container gives it a new network IP, but its
embedded k3s pinned the old one in `rancher-data` — rancher then crash-loops
with "failed to find interface with specified node ip". Fix: remove that
closet's `rancher-data` volume and start rancher again; the bootstraps
re-provision users/auth automatically.

## Rancher UI extension (rancher-extension/)

A Rancher dashboard extension (pkg `magic-closet`, scaffolded per
extensions.rancher.io) that adds a **Magic Closet** page to the cluster
explorer of whatever Rancher it's loaded into (your own instance or the
rancher sidecar): a closet list with live per-closet status and **Create
Closet** (provisions via the controller), and a detail page embedding the
closet's dashboard in an iframe.

- Build (node 24 — use the vscode sidecar, which mounts the source):
  `docker exec -u 1000 magic-closet-vscode bash -c 'cd /rancher-extension && yarn build-pkg magic-closet'`
- The api serves the build at
  `/extension/magic-closet-<version>/magic-closet-<version>.umd.min.js`.
- Load into the rancher sidecar: Extensions → ⋮ → Developer Load (enable
  "Extension developer features" in user preferences first), URL
  `http://api:8080/extension/...` — that endpoint resolves from the
  rancher-browser (which runs with `--allow-running-insecure-content` so the
  https dashboard may load the http script/API). A host browser would need
  `http://localhost:8300/extension/...` instead.
- The extension calls the controller cross-origin (CORS is open); the
  controller API URL is persisted per-browser and editable on the page.
- **Using it from your own Rancher instance**: developer-load the
  GitHub Pages build (published by `.github/workflows/pages.yml` on every
  push): https://codyrancher.github.io/magic-closet/ lists the bundle URL.
  Then set the controller URL on the page to `http://localhost:8300` —
  browsers exempt localhost from mixed-content blocking, so an https Rancher
  can call it. (Local alternative:
  `http://localhost:8300/extension/magic-closet-<v>/...umd.min.js`.)

## Networking between containers

All services share the compose network and reach each other by service name:
`https://rancher`, `http://api:8080`. No shared network namespaces, no socat
forwarders.

Chromium CDP (browser automation) is the one special case: headful Chromium
only binds 127.0.0.1, so the rancher-browser sidecar runs a tiny proxy
([sidecars/dev/rancher-browser/cdp-proxy](sidecars/dev/rancher-browser/cdp-proxy)) that exposes it on
the container IP, and Chrome only accepts IP/localhost Host headers. Use
`cdp-url` (in tools) from any container to get the endpoint:

```bash
node -e '...connectOverCDP(...)...' "$(cdp-url)"
```

## Gotchas

- Run `docker compose` commands **from this directory** — the api service
  mounts the repo at `${PWD}` so compose paths resolve identically inside it.
- After editing `project/`, `api/`, or `sidecars/vscode/` (built images), run
  `docker compose up -d --build`. Sidecars using stock images just need
  `docker compose up -d`.
- `figma` needs `FIGMA_API_KEY` set in `.env` (or `mc start figma apiKey=...`).
