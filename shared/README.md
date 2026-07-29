# shared/

Artifacts shared between the **closet** and the **sidecars**. This whole
directory is mounted into every container at `/shared` (read-only in sidecars,
read-write in the closet), so anything placed here is available everywhere.

- `tools/bin/` — CLIs on `PATH` in every container (`mc`, plus `claude`/`gh`
  which the closet copies in at startup). Reach them at `/shared/tools/bin`.

Put things here when a CLI or the VS Code sidecar might want to use them.
