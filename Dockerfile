# syntax=docker/dockerfile:1

FROM node:26-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build \
 && pnpm prune --prod --ignore-scripts

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node public ./public
# The official image's unprivileged "node" user.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["wget", "-qO-", "http://127.0.0.1:3000/health"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
