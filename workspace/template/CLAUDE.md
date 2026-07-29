# Working inside a magic closet

You're an agent in a **workspace container**: your code is under `/workspace`
(a checked-out repo lives in `/workspace/dashboard`), alongside optional
**sidecar** containers (Rancher, a browser, Keycloak, OpenLDAP, Figma, …) you
drive through a small control API.

## Discover what's running — do this first

Don't assume a fixed set of sidecars; ask the API. `mc` (on your `PATH`) wraps
it:

```bash
mc list        # every sidecar: status, host port, scheme, params, and `notes`
```

Each sidecar's **`notes`** is the source of truth for its URL, how to log in,
and any gotchas — read it before using that sidecar (credentials are referenced
by env var, e.g. `$RANCHER_BOOTSTRAP_PASSWORD`, and are set in your environment).
`mc list` is just `GET http://api:8080/sidecars`.

## Driving sidecars

```bash
mc start rancher tag=v2.14.3 --wait   # start/restart (params are k=v)
mc stop rancher-browser
mc rm figma                            # stop + remove (named volumes kept)
mc run "yarn install"                  # run a command in the workspace container
mc open https://rancher                # open a tab in the rancher-browser sidecar
```

Raw endpoints at `http://api:8080`:

| Method + path | Purpose |
|---|---|
| `GET /sidecars` | list + per-sidecar `notes`, status, host port, params |
| `POST /sidecars/<name>/start` · `/stop` · `DELETE /sidecars/<name>` | lifecycle |
| `POST /exec` | `{ "command": "yarn build" }` → run in the workspace container |
| `POST /browser/open` | `{ "url": "..." }` → open a tab in the rancher-browser |
| `POST /auth/apply` | `{ "provider": "keycloak" }` → set Rancher's auth provider |

Rancher allows **one** external auth provider at a time; `POST /auth/apply`
switches it (for the global admin, use a local-user login). Anything at
`https://rancher` (and OIDC/LDAP logins) only resolves in-network — drive it
through the rancher-browser sidecar, not a host browser.

## The workspace

- Your target repo is cloned into **`/workspace/dashboard`** (rancher/dashboard
  by default).
- **Dev server:** listen on `0.0.0.0:8005` inside this container — it's reachable
  on the host at `$DEV_PORT`. For rancher/dashboard:
  `cd /workspace/dashboard && yarn install && API=https://rancher yarn dev`.
- `git` and `gh` are authenticated when `$GH_TOKEN` is set.

## Defining sidecars

Add or override sidecars from here (they persist and are inherited by future
closets):

```bash
mc create-sidecar postgres image=postgres:16 containerPort=5432 port=POSTGRES_PORT
mc edit-sidecar postgres image=postgres:17      # built-ins too (writes a shadowing override)
mc rm-sidecar postgres
```

Same over HTTP: `POST /sidecars`, `PUT /sidecars/<name>`,
`DELETE /sidecars/<name>/definition`. A custom sidecar is reachable in-network
by service name (`http://<name>:<port>`); give it a host `port` to reach it from
outside. Include a `notes` field so the next agent knows how to use it.
