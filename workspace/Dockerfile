FROM node:22-bookworm-slim

# Base toolchain for working on the source tree
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    python-is-python3 \
    gosu \
    tmux \
    procps \
    jq \
    ripgrep \
    unzip \
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

# nvm baked into the image; copied into the shared /opt/toolchain volume at
# runtime, where the node version (from the repo's .nvmrc) is installed and
# shared with the slim vscode sidecar via /opt/toolchain/node.
RUN mkdir -p /opt/nvm /opt/toolchain \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | NVM_DIR=/opt/nvm PROFILE=/dev/null bash
COPY --chmod=755 setup-node.sh /usr/local/bin/setup-node

# The shared node (/opt/toolchain/node/bin) + the tools bin on PATH everywhere.
ENV PATH="/opt/toolchain/node/bin:/shared/tools/bin:${PATH}"
# Interactive (non-login) and login shells source different files — put both
# dirs on PATH in each so node/yarn and `mc` resolve in terminals.
RUN L='export PATH="/opt/toolchain/node/bin:/shared/tools/bin:$PATH"'; \
    printf '%s\n' "$L" > /etc/profile.d/magic-closet-tools.sh; \
    printf '%s\n' "$L" >> /etc/bash.bashrc

# So VS Code "Attach to Running Container" / Dev Containers connects as the
# non-root user (where claude/git/gh config live), not root.
LABEL devcontainer.metadata='[{"remoteUser":"node"}]'

COPY --chmod=755 entrypoint.sh /entrypoint.sh
# Scaffold files seeded into the closet root (/workspace) at startup (CLAUDE.md, ...)
COPY template /opt/magic-closet/template

RUN mkdir -p /workspace
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
