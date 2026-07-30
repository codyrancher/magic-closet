#!/bin/sh
# Sourced by INTERACTIVE shells in the outer docker-in-docker ("magic-closet")
# container, wired up via `ENV=/magic-closet/dind-shellrc.sh` in
# docker-compose.yml. A shell in the DinD host isn't where you actually work —
# the code, the `mc` CLI, git/gh, and the dev server all live in the workspace
# container — so a plain `docker exec -it magic-closet sh` hops straight there.
#
# Safe by design:
#   * interactive shells only (never disturbs scripts, builds, or `sh -c`)
#   * never recurses (MC_IN_JUMP guard)
#   * stays in the host shell if the workspace container isn't up
#   * `MC_NO_JUMP=1 docker exec -it magic-closet sh` always gives the raw host

# Interactive only.
case $- in
  *i*) ;;
  *) return 0 ;;
esac

# Escape hatch + recursion guard.
[ -n "$MC_NO_JUMP" ] && return 0
[ -n "$MC_IN_JUMP" ] && return 0

# Resolve the running workspace container: prefer the compose service label,
# fall back to the conventional container name.
_mc_ws=$(docker ps -q -f label=com.docker.compose.service=workspace -f status=running 2>/dev/null | head -n1)
[ -n "$_mc_ws" ] || _mc_ws=$(docker ps -q -f name=magic-closet-workspace-1 -f status=running 2>/dev/null | head -n1)

if [ -n "$_mc_ws" ]; then
  echo "→ jumping into the workspace container ('exit' returns to your terminal)."
  echo "  For the DinD host itself: MC_NO_JUMP=1 docker exec -it magic-closet sh"
  # sh always exists in the workspace; from there prefer bash as a login shell.
  exec docker exec -it -e MC_IN_JUMP=1 "$_mc_ws" \
    sh -lc 'exec "$(command -v bash || command -v sh)" -l'
fi

unset _mc_ws
echo "(workspace container isn't running yet — staying in the DinD host shell.)"
return 0
