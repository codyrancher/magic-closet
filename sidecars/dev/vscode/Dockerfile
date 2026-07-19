FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    gosu \
    procps \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# openvscode-server (Gitpod's VS Code server — good reverse-proxy support)
ARG OPENVSCODE_VERSION=1.96.4
RUN wget -q "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz" \
    && tar -xzf "openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz" \
    && mv "openvscode-server-v${OPENVSCODE_VERSION}-linux-x64" /opt/openvscode-server \
    && rm "openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz"

# GitHub CLI (authenticated via the GH_TOKEN env var / ghToken param)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# fnm for a selectable node version (NODE_VERSION env / nodeVersion param);
# v24 is pre-installed as the offline default
ENV FNM_DIR=/opt/fnm
RUN curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir /usr/local/bin --skip-shell \
    && fnm install 24 \
    && chmod -R a+rX /opt/fnm

# Use the Microsoft marketplace so the Claude extension is available
ENV VSCODE_GALLERY_SERVICE_URL='https://marketplace.visualstudio.com/_apis/public/gallery' \
    VSCODE_GALLERY_ITEM_URL='https://marketplace.visualstudio.com/items'

# Pre-install extensions into a shared, read-only-safe directory
RUN mkdir -p /opt/vscode-extensions \
    && /opt/openvscode-server/bin/openvscode-server --extensions-dir /opt/vscode-extensions --install-extension anthropic.claude-code || true
RUN /opt/openvscode-server/bin/openvscode-server --extensions-dir /opt/vscode-extensions --install-extension Vue.volar || true
RUN chmod -R 755 /opt/vscode-extensions

ENV PATH="/opt/magic-closet/tools/bin:${PATH}"

COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY config/ /opt/vscode-defaults/

RUN mkdir -p /workspace /data
EXPOSE 9000

ENTRYPOINT ["/entrypoint.sh"]
