# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/device-providers/package.json packages/device-providers/
COPY packages/database/package.json packages/database/
RUN pnpm install --frozen-lockfile --filter @flowza/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# --legacy: from pnpm 10, `deploy` refuses a workspace without inject-workspace-packages=true. Enabling that
# globally would change how every workspace dependency is linked for local development and CI too, so the
# escape hatch is scoped to this one command instead.
RUN pnpm -r --filter @flowza/api... run build && pnpm --filter @flowza/api deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
RUN addgroup -S flowza && adduser -S flowza -G flowza
WORKDIR /app
COPY --from=build --chown=flowza:flowza /out ./
USER flowza
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "dist/index.js"]
