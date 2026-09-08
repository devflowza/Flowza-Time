# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/device-providers/package.json packages/device-providers/
COPY packages/database/package.json packages/database/
RUN pnpm install --frozen-lockfile --filter @flowza/worker...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
# --legacy: from pnpm 10, `deploy` refuses a workspace without inject-workspace-packages=true. Enabling that
# globally would change how every workspace dependency is linked for local development and CI too, so the
# escape hatch is scoped to this one command instead.
RUN pnpm -r --filter @flowza/worker... run build && pnpm --filter @flowza/worker deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# WITH_CHROMIUM=1 (fly.reports.toml) adds the PDF renderer: Alpine's Chromium plus Noto Sans / Noto Sans Arabic so
# Latin and Arabic reports both shape correctly. The general worker (fly.worker.toml) is built without it and refuses
# PDF requests with a clear message; CSV/XLSX need nothing extra. playwright-core drives whatever CHROMIUM_PATH names.
ARG WITH_CHROMIUM=0
RUN if [ "$WITH_CHROMIUM" = "1" ]; then apk add --no-cache chromium font-noto font-noto-arabic ttf-liberation && fc-cache -f; fi
RUN addgroup -S flowza && adduser -S flowza -G flowza
WORKDIR /app
COPY --from=build --chown=flowza:flowza /out ./
USER flowza

HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD pgrep -f "dist/index.js" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
