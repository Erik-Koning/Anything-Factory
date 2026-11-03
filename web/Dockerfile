# syntax=docker/dockerfile:1.7
# The web app as a container, for Lightsail (sst.config.ts builds and pushes it; CloudFront is in front). Built from
# the repository's root, since the app compiles the factory's task code (../lib/tasks): `docker build -f web/Dockerfile .`
# The build needs no secrets; the app reads its environment when it starts.

FROM node:24.22.0-alpine3.24 AS deps
WORKDIR /repo/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24.22.0-alpine3.24 AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
# Hosts besides the one CloudFront forwards (x-forwarded-host) that may send server actions, comma-separated.
ARG SERVER_ACTIONS_ORIGINS=""
ENV SERVER_ACTIONS_ORIGINS=$SERVER_ACTIONS_ORIGINS
COPY lib lib
COPY web web
COPY --from=deps /repo/web/node_modules web/node_modules
RUN cd web && npx next build

# Only the standalone server and its static files, as an unprivileged user.
FROM node:24.22.0-alpine3.24 AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S -G app app
COPY --from=build --chown=app:app /repo/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/web/.next/static ./web/.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "web/server.js"]
