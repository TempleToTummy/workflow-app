# Production image for the workflow app. Built and run by deploy/oci/compose.yaml
# (see deploy/oci/README.md), but it's a plain image: any Docker host works.
#
# The runtime stage keeps the full node_modules, dev dependencies included,
# because the container's start command runs scripts/prepare-deploy.ts first
# (schema push, first-run seed, data upgrades, encryption at rest), and that
# needs the Prisma CLI and tsx.

FROM node:22-bookworm-slim AS base
# Prisma's query engine needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app ./
# Mount points: /data holds the SQLite database and backups, /app/.storage the
# (encrypted) uploaded files when STORAGE_DRIVER is local. Both are volumes in
# compose.yaml; the directories exist here so a bare `docker run` still works.
RUN mkdir -p /data /app/.storage && chown node:node /data /app/.storage
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Prepare the database, then hand the process over to the Next.js server so it
# receives SIGTERM directly and drains in-flight requests on shutdown.
CMD ["sh", "-c", "npx tsx scripts/prepare-deploy.ts && exec node_modules/.bin/next start"]
