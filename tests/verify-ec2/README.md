# verify-ec2

End-to-end verification of a magic closet running on a **public** EC2 host, with
a recorded `.webm` per check. These can't be verified from a local closet behind
the harness because Rancher's auto-detected `server-url` must be an address that
a downstream cluster node can reach from AWS.

Checks (one script each, one video each):

| Script | Verifies |
|---|---|
| `running-on-ec2.mjs` | The dashboard loads and the api reports the core sidecars running on the EC2 host. |
| `figma.mjs` | The Figma sidecar starts on demand and reaches `running`. |
| `appco.mjs` | The AppCo OCI chart repo can be added to Rancher and reaches `active` (creds authenticate). |
| `provisioning.mjs` | A single-node RKE2 EC2 cluster provisions to **Active** — a real downstream node registers against the public `server-url`. |

## Running

Stand up the closet on a public EC2 host (Ubuntu, t3.xlarge, ports 22 +
8300-8399 + 8500-8519 open), then from the host:

```bash
# verify.env (not committed): RANCHER_PW, APPCO_EMAIL, APPCO_TOKEN,
#   NODE_TLS_REJECT_UNAUTHORIZED=0, PLAYWRIGHT_BROWSERS_PATH=/work/pw-browsers
docker run --rm --network host --env-file verify.env \
  -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:latest \
  bash /work/run-all.sh          # or: bash /work/one.sh <check>
```

`RANCHER_PW` is the generated admin password from `.state/secrets.env`. Videos
and screenshots land in `videos-out/`. The scripts talk to `localhost:8300`
(dashboard/api) and `localhost:8344` (Rancher) via `--network host`.

> Pure vibes, like the rest of the prototype — deterministic enough to record a
> passing run, not a hardened CI suite. Remember to tear down the host and any
> provisioned downstream nodes afterward.
