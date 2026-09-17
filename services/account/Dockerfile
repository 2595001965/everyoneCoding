# 云端账号服务端镜像（Node 24）
# 仅做构建与运行；不要求本机具备 PostgreSQL / Docker 运行时。
FROM node:24-slim

# 编译 better-sqlite3 原生模块所需工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# 先拷贝清单与锁文件以利用层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY services/account/package.json ./services/account/package.json

RUN pnpm install --registry=https://mirrors.cloud.tencent.com/npm/ --filter @ec/account-service...

# 拷贝源码
COPY services/account ./services/account

WORKDIR /app/services/account

ENV ACCOUNT_HOST=0.0.0.0
ENV ACCOUNT_PORT=3000
ENV ACCOUNT_DB_PATH=/data/account.db
ENV NODE_ENV=production

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "src/server.ts"]
