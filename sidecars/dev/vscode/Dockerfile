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
ARG OPENVSCODE_VERSION=1.109.5
RUN wget -q "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz" \
    && tar -xzf "openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz" \
    && mv "openvscode-server-v${OPENVSCODE_VERSION}-linux-x64" /opt/openvscode-server \
    && rm "openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz"

# This is a thin editor: node (from nvm/.nvmrc) and gh/claude/mc come from the
# closet container via the shared /opt/toolchain volume and the tools mount —
# not baked in here.

# Use the Microsoft marketplace so the Claude extension is available
ENV VSCODE_GALLERY_SERVICE_URL='https://marketplace.visualstudio.com/_apis/public/gallery' \
    VSCODE_GALLERY_ITEM_URL='https://marketplace.visualstudio.com/items'

# Pre-install extensions into a shared, read-only-safe directory
RUN mkdir -p /opt/vscode-extensions \
    && /opt/openvscode-server/bin/openvscode-server --extensions-dir /opt/vscode-extensions --install-extension anthropic.claude-code || true
RUN /opt/openvscode-server/bin/openvscode-server --extensions-dir /opt/vscode-extensions --install-extension Vue.volar || true
RUN chmod -R 755 /opt/vscode-extensions

# Shared node (from the closet's /opt/toolchain volume) + the tools bin on PATH.
ENV PATH="/opt/toolchain/node/bin:/shared/tools/bin:${PATH}"
# The openvscode terminal is an interactive non-login shell that inherits a PATH
# without these dirs, so re-add them where those shells look (/etc/bash.bashrc)
# plus /etc/profile.d for login shells — otherwise node/`mc` aren't found.
RUN L='export PATH="/opt/toolchain/node/bin:/shared/tools/bin:$PATH"'; \
    printf '%s\n' "$L" > /etc/profile.d/magic-closet-tools.sh; \
    printf '%s\n' "$L" >> /etc/bash.bashrc

COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY config/ /opt/vscode-defaults/
# Transparent TLS terminator (run with openvscode's bundled node) so the host
# port is HTTPS — a secure context, required for VS Code web webviews to work.
COPY tls-proxy.mjs /opt/vscode-tls-proxy.mjs

RUN mkdir -p /workspace /data /opt/toolchain
EXPOSE 9000 9443

ENTRYPOINT ["/entrypoint.sh"]
