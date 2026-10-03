FROM node:24-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /workspace
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/platform-web/package.json ./apps/platform-web/package.json
RUN pnpm install --frozen-lockfile --filter @ec/platform-web

COPY apps/platform-web ./apps/platform-web
RUN pnpm --filter @ec/platform-web build

FROM nginx:1.30.5-alpine
COPY apps/platform-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/platform-web/dist /usr/share/nginx/html
EXPOSE 80
