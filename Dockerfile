# syntax=docker/dockerfile:1
# MUM (Go/SQLite) container image. Build from the repository root:
#   docker compose up -d --build
# Builds the frontend and Go runtime; no host Go or Node.js installation needed.

FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
# The lockfile is maintained with npm 11; npm 10 (bundled with node:22)
# rejects its nested peer entries, so pin the same npm before npm ci.
RUN npm install -g npm@11.7.0 --no-audit --no-fund \
 && npm ci --no-audit --no-fund
COPY frontend/ ./
# Vite writes the production bundle to server/dist/ (/src/server/dist).
RUN node node_modules/vite/bin/vite.js build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY server/ ./server/
COPY --from=frontend /src/server/dist ./server/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/mum ./server \
 && /out/mum --version

FROM alpine:3.22
# CA certificates for HTTPS to media services and plex.tv; tzdata for TZ.
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 1000 mum \
 && mkdir /data && chown mum:mum /data
COPY --from=build /out/mum /usr/local/bin/mum
COPY LICENSE /usr/share/licenses/mum/LICENSE
LABEL org.opencontainers.image.title="MUM" \
      org.opencontainers.image.source="https://github.com/MrRobotjs/MUM" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV MUM_DATA_DIR=/data \
    MUM_LISTEN=0.0.0.0:5699
VOLUME /data
EXPOSE 5699
USER mum
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5699/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/mum"]
