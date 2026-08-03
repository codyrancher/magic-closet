FROM node:22-alpine

# docker CLI + compose plugin — commands run against the host daemon via the
# mounted /var/run/docker.sock
RUN apk add --no-cache docker-cli docker-cli-compose bash openldap-clients openssl

# node deps (js-yaml, to read sidecar.yml/group.yml). Installed before the src
# COPY so the layer caches across src edits; server.js resolves /app/node_modules.
COPY workspace/api/package.json workspace/api/yarn.lock /app/
RUN cd /app && corepack enable && yarn install --production --frozen-lockfile && yarn cache clean

COPY workspace/api/src /app/src
# sidecar metadata for kubernetes mode (no repo mount in-cluster)
COPY workspace/sidecars /app/sidecars

EXPOSE 8080
CMD ["node", "/app/src/server.js"]
