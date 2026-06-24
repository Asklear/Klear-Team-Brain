# 服务端镜像（自托管「项目大脑」一键起）。注意：服务端要全量依赖（含飞书 lark SDK —— core/feishu.mjs 顶层 import），
# 不是客户端那份精简包；且真相库是 git 仓，故装 git。客户端走 /get 自托管下发，不在本镜像里跑。
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# 真相库 + 配置都落到 /data（compose 用命名卷/绑定挂载持久化）。HOST=0.0.0.0 让容器外可达，
# 但安全靠 compose 只把端口绑到回环 / 或走 tls profile（见 docker-compose.yml 注释）。NO_POLL 默认关轮询（本地无外部凭证）。
ENV TRUTH_DIR=/data/truth \
    HOST=0.0.0.0 \
    PORT=8787 \
    NO_POLL=1 \
    TEAM_FILE=/data/config/team.yaml \
    TOKENS_FILE=/data/config/tokens.yaml \
    REGISTRY_FILE=/data/config/registry.yaml \
    FEISHU_FILE=/data/config/feishu.yaml \
    PUBLIC_URL=http://localhost:8787

EXPOSE 8787
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
