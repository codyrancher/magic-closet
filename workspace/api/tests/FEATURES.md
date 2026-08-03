# magic closet — feature inventory

Every feature the project currently ships, grouped by area. The **T** column
marks what the integration suite (`tests/api.test.mjs`) covers; **live** means it
needs a real container/Rancher/AWS stack and is verified by running the stack,
not by the mocked suite.

## Deployment / infra
| Feature | T |
|---|---|
| Single-DinD standalone (`docker compose up -d` → one privileged container) | live |
| First-boot auto-setup: create `.env`, build the stack inside the DinD | live |
| Port derivation — every host port derived from `API_PORT` (offset table) | ✅ |
| Per-port override (explicit `*_PORT` in `.env` wins over derivation) | ✅ |
| Generated login secrets at init into gitignored `.state/secrets.env` (not `.env`) | ✅ |
| Public-host auto-detection for Rancher `server-url` (EC2 IMDS → echo service) | live |

## Control API (`closet/api/src/server.js`)
| Endpoint / behavior | T |
|---|---|
| `GET /health` | ✅ |
| `GET /` dashboard, `GET /favicon.svg` | ✅ |
| `GET /sidecars` — discovery, status, health, hostPort, params, rancherAuth, rancher{running,authProvider} | ✅ |
| `POST /sidecars/<name>/start` — validate+persist params, `compose up -d` | ✅ |
| unknown sidecar → 404, unknown param → 400 | ✅ |
| `POST /sidecars/<name>/stop` — `compose stop` | ✅ |
| `DELETE /sidecars/<name>` — `compose rm -sf` | ✅ |
| `GET /sidecars/<name>/logs` and `/logs/stream` (live `docker logs -f`) | live |
| `GET /sidecars/<name>/params/<id>/options` — `dockerhub` / `github-releases` / `github-node-engines` | ✅ |
| `POST /exec` (+ `/project/exec` alias) — run in the closet container | ✅ |
| `POST /auth/apply` — set Rancher auth provider, persist `RANCHER_AUTH_PROVIDER` | ✅ |
| `POST /browser/open` + `GET /browser/queue` — open/queue a rancher-browser tab | ✅ |
| `GET /closets`, `POST /closets`, `DELETE /closets/<name>` — multi-closet controller | ✅ |
| `POST /sidecars` / `PUT /sidecars/<name>` / `DELETE /sidecars/<name>/definition` — custom sidecars | ✅ |
| `GET /extension/...` — serve the Rancher UI extension build | live |
| HTTPS listener on :8443 (self-signed, for mixed-content) | live |

## Sidecars
| Sidecar | What | T |
|---|---|---|
| closet (core) | source + node toolchain; target of `/exec` | ✅ (discovery/exec) |
| rancher-browser | Chromium + quick-login/command-menu extension; CDP proxy | live |
| rancher | Rancher server; `tag`/`prime` params; bootstrap (below) | ✅ (params/discovery) |
| keycloak | Keycloak OIDC/SAML provider; bootstrap | ✅ (discovery/auth) |
| openldap | OpenLDAP directory; bootstrap | ✅ (discovery/auth) |
| figma | Figma MCP server | ✅ (lifecycle) |
| custom | user-defined via the API, inherited by future closets | ✅ |

## Rancher bootstrap (on rancher start)
| Feature | T |
|---|---|
| Admin login + `first-login=false`, `agent-tls-mode` | live |
| `server-url` set to the external host | live |
| Standard users `user1`-`user3` | live |
| AWS cloud credential from `AWS_ACCESS_KEY`/`SECRET` | live |
| Auth provider applied (Keycloak OIDC/SAML, OpenLDAP) | live |

## Dashboard UI
| Feature | T |
|---|---|
| Cards: status dot, description, per-sidecar Configuration accordion | live |
| Launch / Internal Launch links; live logs modal | live |
| Auth Provider selector on the rancher card (disabled when a provider isn't running) | live |
| Tag picker sourced from actual GA releases | ✅ (options endpoint) |
| Start / Stop / Restart actions | ✅ (endpoints) |

## `mc` CLI (`shared/tools/bin/mc`)
`list`, `start`, `stop`, `rm`, `run`, `open`, `create-sidecar`, `edit-sidecar`,
`rm-sidecar` — thin wrappers over the API. Covered indirectly (they call the
tested endpoints); a live smoke test lives in the stack.
</content>
