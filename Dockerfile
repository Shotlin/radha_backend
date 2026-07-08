# RADHA backend -- production image (NestJS API / worker / scheduler).
# Standalone single-package build (this repo IS the app, not a monorepo
# subdirectory) -- build with: docker build -t radha-server .
#
# One image, three entrypoints -- the compose file overrides the command
# for worker + scheduler. Postgres/Redis run as sibling containers in the
# same compose project (see docker-compose.selfhosted.yml).
#
# `nest build` (tsc) does not rewrite the `@/*` path alias in dist/, so
# the build runs `tsc-alias -p tsconfig.build.json` after (see
# package.json "build") to rewrite every `@/x` import into a real
# relative path -- dist/ needs no runtime path resolver.

FROM node:20-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate
WORKDIR /app

COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --no-frozen-lockfile \
 && pnpm build

ENV NODE_ENV=production
USER node
EXPOSE 3000

CMD ["node", "dist/main.api.js"]
