# Pin the multi-architecture Node LTS image digest; update deliberately alongside
# the documented runtime and dependency versions.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base

WORKDIR /app

FROM base AS build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.9.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm check \
	&& pnpm lint \
	&& pnpm test \
	&& pnpm build \
	&& pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/shopping-list.sqlite
ENV SHUTDOWN_TIMEOUT=20
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends libstdc++6 \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --system --gid 10001 shopping \
	&& useradd --system --uid 10001 --gid shopping --home-dir /app shopping \
	&& mkdir -p /data \
	&& chown shopping:shopping /data

COPY --from=build --chown=shopping:shopping /app/package.json ./package.json
COPY --from=build --chown=shopping:shopping /app/node_modules ./node_modules
COPY --from=build --chown=shopping:shopping /app/build ./build
COPY --from=build --chown=shopping:shopping /app/migrations ./migrations
COPY --from=build --chown=shopping:shopping /app/scripts/start.mjs ./scripts/start.mjs
COPY --from=build --chown=shopping:shopping /app/scripts/backup.mjs ./scripts/backup.mjs
COPY --from=build --chown=shopping:shopping /app/src/lib/server/config.js ./src/lib/server/config.js
COPY --from=build --chown=shopping:shopping /app/src/lib/server/db/lifecycle.js ./src/lib/server/db/lifecycle.js
COPY --from=build --chown=shopping:shopping /app/src/lib/server/db/sqlite.js ./src/lib/server/db/sqlite.js
COPY --from=build --chown=shopping:shopping /app/src/lib/server/db/backup.js ./src/lib/server/db/backup.js

USER shopping
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD node -e "const http = require('node:http'); const req = http.get({ hostname: '127.0.0.1', port: 3000, path: '/healthz', headers: { host: new URL(process.env.CANONICAL_ORIGIN).host } }, (res) => { res.resume(); if (res.statusCode !== 200) process.exitCode = 1; }); req.on('error', () => process.exit(1));"

CMD ["node", "scripts/start.mjs"]
