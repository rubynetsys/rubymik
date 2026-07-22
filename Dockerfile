# RubyMIK — multi-arch image (linux/amd64, linux/arm64, linux/arm/v7)
#
# All dependencies are pure JavaScript (SQLite ships inside Node itself), so the
# build stages always run on the build host's native arch ($BUILDPLATFORM) and the
# per-arch final stage only copies files — cross-builds need no native compilation.
#
# Base is node:22 (LTS): the last Node line published for linux/arm/v7 (older
# Raspberry Pis). node:sqlite needs >= 22.13.

FROM --platform=$BUILDPLATFORM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-alpine AS serverbuild
WORKDIR /srv
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    RUBYMIK_PORT=8080 \
    RUBYMIK_DATA_DIR=/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
# wireguard-tools + iproute2 are used ONLY by the opt-in remote-access hub. They
# are inert for a default (LAN-only) deployment — nothing runs them unless the
# operator enables WireGuard AND runs with NET_ADMIN (see docker-compose.wireguard.yml).
RUN apk add --no-cache wireguard-tools iproute2
COPY --from=serverbuild /srv/package.json ./package.json
COPY --from=serverbuild /srv/node_modules ./node_modules
COPY --from=serverbuild /srv/dist ./dist
COPY --from=webbuild /web/dist ./public
RUN mkdir -p /data /offhost && chown node:node /data /offhost /app
USER node
VOLUME /data
# P36: a second volume as the off-host copy stand-in (a mounted path). node-owned
# so the app can write to it. Real off-host (SFTP/rclone/share) is PENDING-RAY.
VOLUME /offhost
# 8080 = dashboard/API; 8081 = WebFig reverse proxy (router admin UIs need
# web-root '/', so they get their own listener). See RUBYMIK_WEBFIG_PORT.
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RUBYMIK_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
