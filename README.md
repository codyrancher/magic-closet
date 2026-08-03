# magic closet

Two ways to run a throwaway Rancher / dashboard dev environment:

- **[Standalone](#standalone)** — one Docker-in-Docker container on your machine:
  the workspace (your source + node), opt-in sidecars (a Chromium browser,
  Rancher, Keycloak, ...), and a small control dashboard. Nothing but that one
  container lands on your host.
- **[Rancher Extension](#rancher-extension)** — a Rancher UI extension that
  provisions the same environment as a **closet** on a Kubernetes cluster, with a
  VS Code tunnel and the dev server exposed for remote work.

The deep guide — ports, profiles, sidecar parameters, adding sidecars, the `mc`
CLI — is in [CLAUDE.md](CLAUDE.md).

## Standalone

A dev environment as a closet of optional containers — one **workspace** container
(your source + node) plus opt-in **sidecars** (a Chromium browser, Rancher,
Keycloak, ...), all managed from a small dashboard. The whole stack runs inside a
single Docker-in-Docker container, so nothing but that one container lands on your
host.

### Start

Requires Docker. From this directory:

**1. (Optional) Generate `.env`:**

```bash
./setup.sh          # copies .env.example → .env
```

Then edit `.env` to fill in what you want — ports, tokens, or which sidecars
start. **You can skip this entirely** if you just want to try it out:
`docker compose up -d` runs with sensible defaults and generates what it needs
(the `.env` and login secrets) on first boot.

**2. Start everything:**

```bash
docker compose up -d
```

The first run builds the stack inside the container (give it a few minutes —
watch with `docker compose logs -f`). Then open the dashboard:

**http://localhost:8300**

Start/stop sidecars and open them (a browser, Rancher, ...) from there.

### Everyday commands

```bash
docker compose logs -f            # boot + build progress
docker exec -it magic-closet bash # shell inside (as root); `su - node` for the dev user
docker compose down               # stop (all state kept in ../instance/magic-closet)
rm -rf ../instance/magic-closet   # wipe all persistent state
```

## Rancher Extension

A Rancher dashboard extension (pkg `magic-closet`) that adds a **Magic Closet**
page to the cluster explorer of any Rancher: a list of closets with live status
and **Create Closet**, plus a per-closet detail page. Each closet runs the same
workspace + sidecars as standalone, but as a pod on a Kubernetes cluster (deployed
via the `closet` Helm chart under [rancher-extension/charts/](rancher-extension/charts/)).

The detail page surfaces what you need to work in a closet remotely:

- the closet's own control dashboard, embedded;
- the **dev server** (rancher/dashboard running in the closet), exposed via a
  NodePort with external HMR wired up;
- a **VS Code tunnel** — device-login code + connect link, so you attach VS Code
  with no `kubectl`;
- a **Remote-SSH** command for a terminal/editor over SSH.

### Install into your Rancher

Enable *Extension developer features* in user preferences first, then:

1. Rancher → Extensions → ⋮ → **Manage Repositories** → **Create**, URL
   `https://codyrancher.github.io/magic-closet/`.
2. Install the **magic-closet** extension (or Developer-Load a bundle URL listed
   on that page directly), and set the controller URL on the page.

The catalog is published to GitHub Pages by
[.github/workflows/pages.yml](.github/workflows/pages.yml) on every push to
`master`.

### Build

```bash
cd rancher-extension
yarn install && yarn build-pkg magic-closet
```

Chart layout, the controller wiring, and how to load a local build into the
rancher sidecar are in [CLAUDE.md](CLAUDE.md).
