# syntax=docker/dockerfile:1
# 看着办 · Agent 工作台 —— 单镜像运行前端产物 + decision-desk 后端 + 行为验证用的 Chromium。
# 镜像内已经包含全部依赖，宿主机只需要 Docker，不需要 Node / pnpm / 浏览器。

ARG NODE_IMAGE=node:24-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---------- 依赖 ----------
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && npm config set registry ${NPM_REGISTRY}
WORKDIR /app
COPY decision-desk/package.json decision-desk/pnpm-lock.yaml decision-desk/pnpm-workspace.yaml ./decision-desk/
RUN cd decision-desk \
 && pnpm config set registry ${NPM_REGISTRY} \
 && pnpm install --frozen-lockfile
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --registry=${NPM_REGISTRY}

# ---------- 构建前端产物 ----------
FROM deps AS build
WORKDIR /app
COPY decision-desk/ ./decision-desk/
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ---------- 运行 ----------
FROM ${NODE_IMAGE} AS runtime
ARG NPM_REGISTRY
# Chromium 供 verify_app 的行为验证使用；Noto CJK 保证页面里的中文能被正确渲染与截图。
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/decision-desk/node_modules ./decision-desk/node_modules
COPY decision-desk/ ./decision-desk/
# decision-desk/server 运行时确实会 import 仓库根部的 src/stream.ts 与 src/work-unit.ts，
# 根 package.json 提供 "type": "module"，两者缺一后端起不来。
COPY src/ ./src/
COPY package.json ./package.json
COPY --from=build /app/frontend/dist ./frontend/dist
# 运行期不需要前端源码与 node_modules，只保留构建产物。
RUN rm -rf ./decision-desk/.data ./decision-desk/tests \
 && mkdir -p /data/runs && chown -R node:node /data /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    DATA_DIR=/data/runs \
    FRONTEND_DIST=/app/frontend/dist \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_ARGS="--no-sandbox --disable-dev-shm-usage"
USER node
WORKDIR /app/decision-desk
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts", "--production"]
