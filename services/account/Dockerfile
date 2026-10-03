FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY services/account ./services/account
RUN pnpm install --frozen-lockfile --filter @ec/account-service... --prod

WORKDIR /app/services/account
RUN mkdir -p /data /run/platform-secrets \
  && chown -R node:node /data \
  && chmod 700 /data \
  && chmod 700 /run/platform-secrets

ENV NODE_ENV=production
ENV ACCOUNT_HOST=0.0.0.0
ENV ACCOUNT_PORT=3000
ENV ACCOUNT_DB_PATH=/data/account.db
ENV ACCOUNT_PLATFORM_SECRET_DIR=/run/platform-secrets

USER node
EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
