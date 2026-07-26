# tests

Integration tests for the magic-closet control API. They boot the **real**
`api/src/server.js` in-process against a throwaway `MC_ROOT`, with `docker` and
`fetch` **mocked** — so no containers, Rancher, or AWS are needed and nothing on
your machine is touched.

```bash
tests/run.sh          # runs the suite in a node:22 container (no host node needed)
# or, if you have node ≥ 20:
node --test --test-concurrency=1 tests/api.test.mjs
```

- `FEATURES.md` — the full feature inventory and what's covered here vs. what
  needs a live stack.
- `api.test.mjs` — the tests, grouped by feature (discovery, lifecycle, exec,
  options, closets, custom sidecars, auth, browser, secrets, port derivation).
- `harness.mjs` — sets up the temp root, the mock `docker`, the mock `fetch`,
  and boots the server; exports request/assertion helpers.
- `mock/docker` — the `docker` shim (records invocations, answers ps/inspect/
  exec/compose).

**What's mocked:** `docker` (a shim on PATH records commands and reports
container state from a small state file the tests flip), and `fetch` (Docker Hub
/ GitHub for the options endpoints). Everything else — routing, param
validation, `.env`/secrets handling, port derivation, closet + custom-sidecar
file generation — is the real server code.

**Not covered here (needs the live stack):** the actual Rancher/Keycloak/OpenLDAP
bootstrap, real cluster provisioning, the vscode HTTPS webview fix, and the
dashboard UI. Those are exercised by running the stack (`docker compose up -d`).
