# The magic-closet ROOT image: a docker-in-docker host that ALSO holds the
# workspace dev environment and the control-plane api. Built from a glibc base
# (so the native `claude` binary and node run) with the Docker engine installed
# so it can run the nested sidecar stack when the container is privileged.
#
# What used to be three things — the stock docker:dind root, the `workspace`
# container, and the `api` container — is now this one image. Only the sidecars
# stay nested. Entrypoint is the repo's dind-entrypoint.sh (bind-mounted), so it
# isn't COPYd here; the repo (template, api src, setup-node, shared) is mounted
# at /magic-closet at runtime.
FROM node:22-bookworm-slim

# ---- Docker engine (dockerd) + compose, for running the nested sidecars ----
RUN install -m 0755 -d /etc/apt/keyrings \
    && apt-get update && apt-get install -y ca-certificates curl gnupg \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# ---- Workspace toolchain (was workspace/Dockerfile) + api deps ----
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    python3 \
    python-is-python3 \
    gosu \
    tmux \
    procps \
    jq \
    ripgrep \
    unzip \
    ldap-utils \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (native binary)
RUN CLAUDE_VERSION=$(curl -fsSL https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest) \
    && curl -fsSL -o /usr/local/bin/claude "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${CLAUDE_VERSION}/linux-x64/claude" \
    && chmod +x /usr/local/bin/claude

# nvm baked in; the entrypoint's setup-node copies it into the shared toolchain
# dir (under MC_DATA_DIR) at runtime and installs the repo's node version there.
# (/opt/toolchain is NOT created here — the entrypoint symlinks it to the shared
# data dir; a pre-existing dir would make `ln` nest the link inside it.)
RUN mkdir -p /opt/nvm \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | NVM_DIR=/opt/nvm PROFILE=/dev/null bash

# The shared node (/opt/toolchain/node/bin) + the tools bin on PATH everywhere.
ENV PATH="/opt/toolchain/node/bin:/shared/tools/bin:${PATH}"
RUN L='export PATH="/opt/toolchain/node/bin:/shared/tools/bin:$PATH"'; \
    printf '%s\n' "$L" > /etc/profile.d/magic-closet-tools.sh; \
    printf '%s\n' "$L" >> /etc/bash.bashrc

# So VS Code "Attach to Running Container" on THIS (root) container connects as
# the non-root user (where claude/git/gh config live), not root.
LABEL devcontainer.metadata='[{"remoteUser":"node"}]'

WORKDIR /magic-closet
