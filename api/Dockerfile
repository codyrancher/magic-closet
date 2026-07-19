FROM node:22-alpine

# docker CLI + compose plugin — commands run against the host daemon via the
# mounted /var/run/docker.sock
RUN apk add --no-cache docker-cli docker-cli-compose bash openldap-clients openssl

COPY src /app/src

EXPOSE 8080
CMD ["node", "/app/src/server.js"]
