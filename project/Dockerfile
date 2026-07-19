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

# Shared tools directory (bind-mounted at runtime, on PATH everywhere)
ENV PATH="/opt/magic-closet/tools/bin:${PATH}"

COPY --chmod=755 entrypoint.sh /entrypoint.sh

RUN mkdir -p /workspace
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
