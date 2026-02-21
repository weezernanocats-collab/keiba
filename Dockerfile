FROM node:20-alpine AS base

# 必要なライブラリ（better-sqlite3のビルドに必要）
RUN apk add --no-cache python3 make g++ sqlite

# ==================== 依存関係インストール ====================
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production && \
    cp -R node_modules /prod_node_modules && \
    npm ci

# ==================== ビルド ====================
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# データディレクトリ作成
RUN mkdir -p data

# Next.jsビルド
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ==================== 本番環境 ====================
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# セキュリティ: 非rootユーザーで実行
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 必要なファイルのみコピー
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# データディレクトリ作成（永続化ボリューム用）
RUN mkdir -p data && chown nextjs:nodejs data

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
