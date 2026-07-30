# magic closet

A project development environment built from small, optional pieces. **One**
privileged container is the whole base: the docker-in-docker host, the workspace
dev environment (your code + node + claude + the `mc` CLI), and the control API.
Everything else (VS Code, a browser, Rancher, MCP servers, ...) is a **sidecar**
— an independent, optional container nested inside it, with its own directory
under `sidecars/`.

Start everything with a single command from this directory:

```bash
docker compose up -d
```

Which sidecars that command starts is controlled by `COMPOSE_PROFILES` in
`.env` (run `./setup.sh` once first — it creates `.env` from the example and
fills in generated secrets).

## Single-container (DinD) model

`docker compose up -d` builds and starts **one** privileged container,
`magic-closet` (see `Dockerfile`), that runs its own inner dockerd. That
container **is** the workspace dev environment and the control api; only the
**sidecars** run as *nested* containers inside it — nothing else lands on the
host docker. The host publishes the `8300-8399` block (the api on 8300 + each
sidecar's derived port).

- `Dockerfile` — the **root image**: a glibc base with the Docker engine, the
  workspace toolchain (node/nvm, claude, gh, `mc`, build tools), and the api's
  runtime baked in. dockerd runs as root; you work/attach as the `node` user.
- `docker-compose.yml` — the wrapper that runs it: `build: .`, the repo
  bind-mounted at `/magic-closet`, the `mc-docker` volume for nested docker
  data, and the `8300-8399` port mapping. It also mounts a sibling
  **`../instance/magic-closet`** at `/magic-closet-data` (env `MC_DATA_DIR`) —
  the runtime/instance state (`.state`, `workspace`, `toolchain`, `claude-data`)
  lives there, out of the source tree.
- `dind-entrypoint.sh` — PID 1 of that container: boots the inner dockerd, sets
  up the workspace (node user, `/workspace`, shared toolchain, claude), brings
  up the sidecars (`docker compose -f compose.stack.yml up -d --build`), and
  runs the api.
- `compose.stack.yml` — just the **sidecars** (the `include:` of each). The api
  drives nested compose with this file (via `MC_COMPOSE_FILE`), talking to the
  inner socket with `MC_ROOT=/magic-closet`.

Everyday commands:
```bash
docker compose up -d                 # build + start (first run builds the image + inner stack)
docker compose logs -f               # inner dockerd + "compose up" progress
docker exec -it magic-closet bash    # shell in as root; `su - node` for the dev user
docker compose down                  # stop all (nested data kept in mc-docker)
docker compose down -v               # also wipe nested docker data
```

VS Code: Dev Containers → **Attach to Running Container → `magic-closet`** — it
connects as `node` (the image's `remoteUser` label), where `/workspace`, claude,
and `mc` all live. No extra setup.

## Layout

The two things worth caring about first — `workspace/` (the control API, the
sidecars, and the workspace image all live under it) and `rancher-extension/` —
plus the orchestration files:

```
magic-closet/
├── Dockerfile           # the root image: dind + workspace toolchain + api
├── docker-compose.yml   # wrapper that runs the root container
├── compose.stack.yml    # the nested sidecars (include: of each)
├── dind-entrypoint.sh   # dockerd + workspace setup + sidecars up + api
├── .env                 # profiles, host ports, sidecar parameters
├── workspace/           # everything the root container & the sidecars use
│   ├── api/             # control API src (runs in the root container) + its tests/
│   ├── template/        # scaffold seeded into /workspace at start
│   ├── sidecars/        # one dir per sidecar (compose.yml + sidecar.json [+ Dockerfile])
│   └── shared/          # artifacts shared into every container at /shared (tools/bin/mc, ...)
└── rancher-extension/   # Rancher UI extension (Vue plugin) + charts/ (Helm chart)
```

Runtime/instance state — the cloned `/workspace` (the root container clones
rancher/dashboard into `/workspace/dashboard`), the shared `toolchain` and
`claude-data`, and `.state` — lives in the sibling `../instance/magic-closet`
(see the model note above), not in the source tree.

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
Edit `workspace/sidecars/<name>/compose.yml`. It's a normal compose file; the only
conventions are:

1. `profiles: ["<name>"]` — keeps the sidecar optional (profile = dir name).
2. No `container_name` — compose names containers per project, and the API
   finds them via compose labels (required for multiple closets).
3. Paths are relative to the **repo root** (the include uses
   `project_directory: .`), e.g. `./workspace/shared`, `./workspace/sidecars/<name>/...`.
4. Tunables are exposed as env vars with defaults (`${RANCHER_TAG:-head}`) and
   declared in `sidecar.json` so the API can set them.

### Seeding startup files (`template/`)
A sidecar that **builds its own image** carries a `template/` dir, baked in and
copied into the container at startup — the convention for initializing data:
the **workspace** seeds `workspace/template/` into its root (`/workspace`), and
**vscode** seeds `workspace/sidecars/dev/vscode/template/` (VS Code defaults) into its
data dir. **Stock-image sidecars** can't bake a template, so they initialize
another way: rancher/keycloak/openldap via the API bootstrap, rancher-browser
via the image's `custom-cont-init.d` hook (`ext-init`, which renders creds).

### Sidecar groups
A directory under `sidecars/` **without** a `compose.yml` is a group; its
subdirectories are sidecars (e.g. `workspace/sidecars/auth/keycloak`,
`workspace/sidecars/auth/openldap`). The dashboard renders each group as a titled
section; the API reports the group on each sidecar. Profile and service
names stay flat (`keycloak`) — the group is purely organizational.

### Add a new sidecar
1. `mkdir workspace/sidecars/<name>` (or `sidecars/<group>/<name>`) with a `compose.yml`
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

   Internal secrets are not params and are never authored by hand — list their
   env vars in a top-level `"secrets"` array instead (see rancher's
   `RANCHER_BOOTSTRAP_PASSWORD`). Name them `*_PASSWORD` / `*_SECRET`. They
   never appear in the dashboard, the start API, `.env`, or `.env.example`.
   Every `secrets`-array entry is generated at init into the gitignored
   `.state/secrets.env` (kept out of the human `.env`): `dind-entrypoint.sh`
   scans the sidecar.json files, generates any missing one there **once** —
   reused on later boots so rancher/keycloak (which persist their own copy in
   volumes) don't break on restart — and exports them so `compose up`
   interpolates `${*_PASSWORD}`. The api reads `.env` **and** `.state/secrets.env`
   (and passes the latter as a second `--env-file` when it starts a sidecar),
   and regenerates any still-missing into `.state/secrets.env` before a start.
   Look a value up in `.state/secrets.env` when you need to log in.
2. Add it to the `include:` list in `docker-compose.yml`.
3. Optionally add its profile to `COMPOSE_PROFILES` and its port/params to
   `.env` / `.env.example`.

The API discovers sidecars by scanning `sidecars/*/sidecar.json` — no code
changes needed.

A param can also declare a suggested-values source; the dashboard then renders
it as a taggable dropdown (suggestions + free text) and the API serves them at
`GET /sidecars/<name>/params/<id>/options`.

`github-releases` lists a repo's actual GA releases — prereleases (rc/alpha) and
drafts excluded — newest first. This is what the rancher `tag` param uses, so
the picker only offers real releases (`head` and `vX.Y-head` dev builds are not
releases — type `head` in the field to run the dev build):

```json
"options": {
  "source": "github-releases",
  "repo": "rancher/rancher",  // owner/repo
  "limit": 15,                // keep the newest N GA tags
  "pattern": "^v\\d+\\.\\d+\\.\\d+$", // optional; default GA-semver filter
  "prepend": ["head"]         // optional fixed values, listed first
}
```

`dockerhub` lists a Docker image's tags (server-side `filter`, `pattern` to
keep, `nextMinor` to also suggest one minor past the newest, `prepend` for
fixed values):

```json
"options": {
  "source": "dockerhub", "repo": "rancher/rancher",
  "filter": "head", "pattern": "^v2\\.\\d+-head$", "nextMinor": true, "prepend": ["head"]
}
```

A third source, `github-node-engines`, lists the node major versions a
GitHub repo's branches declare in `package.json` `engines.node` (main branch's
version first, then the last `limit` `branchPrefix` branches):

```json
"options": { "source": "github-node-engines", "repo": "rancher/dashboard",
             "mainBranch": "master", "branchPrefix": "release-2.", "limit": 6 }
```

(No sidecar uses this today — the workspace's node version comes from the
workspace's `.nvmrc`, see `workspace/setup-node.sh`, not a param.)

A param with `"defaultFromOptions": true` gets its default from the first
option: when its env var is unset in `.env`, the api resolves the options and
persists option[0] — at boot and before any start.

Results are cached for 10 minutes; if the upstream (Docker Hub / GitHub) is
unreachable the endpoint falls back to the `prepend` values.

### Remove a sidecar
Delete its directory and its `include:` entry, and drop its profile from
`COMPOSE_PROFILES`.

## The control API

The api runs in the root container (it is core, not a sidecar) and drives
`docker compose` through the inner docker socket.

```
GET    /                        dashboard: sidecar cards with status, params, start/stop/delete
GET    /sidecars                list sidecars: status, health, host port, params + current values
POST   /sidecars/<name>/start   body: { "params": {"tag": "v2.11-head"}, "wait": true }
POST   /sidecars/<name>/stop    stop the container (kept for fast restart)
DELETE /sidecars/<name>         stop + remove the container (named volumes kept)
POST   /exec            { "command": "yarn build" } → runs in /workspace (as node)
POST   /browser/open            { "url": "https://rancher" } → open a tab in the rancher-browser
                                sidecar; 202 + queued if the browser isn't ready, and the
                                queue is flushed (FIFO) once it comes up
GET    /browser/queue           tabs still waiting for the browser
```

- `start` params are validated against `sidecar.json` and **persisted to
  `.env`**, so a later `docker compose up -d` keeps them.
- **Params are global**: every container (closet + every sidecar) loads
  `.env` via `env_file`, so an argument passed for one sidecar is readable as
  an env var in all of them (e.g. `RANCHER_TAG`). Generated login secrets live
  in `.state/secrets.env` instead and reach containers via `${*_PASSWORD}`
  interpolation in each service's `environment:` (see the secrets note above).
  A container picks up changed values the next time it is recreated — starting
  a sidecar through the API does that for the sidecar itself; others follow on
  their next `docker compose up -d`.
- `"wait": true` blocks until the container is healthy (uses the compose
  healthcheck if the sidecar defines one).
- The api runs in the root container and listens on `${API_PORT}` (8300, http)
  and `${API_HTTPS_PORT}` (8301, self-signed https — for https dashboards that
  would otherwise hit mixed-content blocking). From the host:
  `http://localhost:8300`. From a **sidecar**: `http://host.docker.internal:8300`
  (sidecars that call the api add `extra_hosts: ["host.docker.internal:host-gateway"]`).

### The `mc` CLI
`shared/` is mounted into every container at `/shared` (and `/shared/tools/bin`
is on PATH in the images we build), so all sidecars share the same CLI tools —
including `claude` and `gh`, which the root container copies into
`/shared/tools/bin` at startup. `shared/` is the place for any artifact meant to
be reachable from the root container and the sidecars.

```bash
mc list                          # sidecars + status
mc start rancher tag=v2.11-head --wait
mc stop rancher-browser
mc rm figma
mc run "yarn install"            # executes in /workspace (as the node user)
mc open https://rancher          # open a browser tab (queued until the browser is up)
```

On the host, prefix with `MC_API_URL=http://localhost:8300`.

## The root container (workspace + api)

The `magic-closet` container holds `/workspace` (node 22, git, gh, claude), runs
the control API, and hosts the nested sidecars. Get a shell with
`docker exec -it magic-closet bash` (root), then `su - node` for the dev user —
or `claude-session` for a persistent tmux Claude session. Dev servers should
listen on `0.0.0.0:${DEV_PORT}` (8305) — host ports map 1:1. If
`workspace/init.sh` exists it runs (backgrounded, log: `workspace/.init.log`) at
startup.

## Workspace code (GITHUB_URL)

The vscode sidecar's `githubUrl` param points at a GitHub PR, issue, or repo;
the api clones it into `/workspace/dashboard` (blob-less partial clone), locally
as the node user:

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

## Sidecar containers

No fixed `container_name`s anywhere — the api finds containers via compose
labels (`com.docker.compose.service=<name>`). Sidecars that build an image carry
explicit tags (`magic-closet-vscode`).

**Rancher's node IP is pinned.** Rancher's embedded k3s/etcd pins its peer url to
the container's ip; if that ip changed on a restart (e.g. the root container
being recreated) the apiserver would crash-loop. So rancher holds a **static ip**
(`172.28.0.10`, hostname `rancher`) on a fixed inner subnet — see the `networks:`
block in `compose.stack.yml` and the pin in `workspace/sidecars/dev/rancher/compose.yml`.
If rancher ever does get wedged, remove its `rancher-data` volume and restart it;
the bootstraps re-provision users/auth automatically.

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
  `http://host.docker.internal:8300/extension/...` (the api runs in the root
  container; the rancher-browser reaches it via a host-gateway `extra_hosts`).
  A host browser would use `http://localhost:8300/extension/...` instead.
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

Sidecars share the compose network and reach each other by service name:
`https://rancher`. The **api** isn't on that network (it's the root container),
so sidecars reach it at `http://host.docker.internal:8300` via a host-gateway
`extra_hosts`. No shared network namespaces, no socat forwarders.

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
- After editing the root `Dockerfile` (toolchain/api deps) rebuild the root
  container: `docker compose up -d --build`. After editing the api source
  (`workspace/api/`) just restart the api (it runs from the mounted repo). After
  editing `workspace/sidecars/dev/vscode/` (built image) run
  `docker compose up -d --build`; stock-image sidecars just need `up -d`.
- `figma` needs `FIGMA_API_KEY` set in `.env` (or `mc start figma apiKey=...`).
