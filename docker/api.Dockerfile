FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm install

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build --workspace=@droidforge/shared && npm run build --workspace=@droidforge/api

FROM node:24-bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    android-tools-adb \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm install --omit=dev

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/api/dist apps/api/dist

ENV NODE_ENV=production
ENV API_PORT=13000
ENV DATA_DIR=/data
ENV HOME=/data

EXPOSE 13000

CMD ["node", "apps/api/dist/server.js"]
