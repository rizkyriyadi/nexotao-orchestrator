# syntax=docker/dockerfile:1

# ---- Stage 1: build the React frontend ----
FROM node:22-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Stage 2: build the server ----
FROM node:22-slim AS server-build
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/server

# Install production deps only.
COPY server/package*.json ./
RUN npm ci --omit=dev

# Compiled server + built frontend (served from ./public).
COPY --from=server-build /server/dist ./dist
COPY --from=web /web/dist ./public

# Agent workspace (mount a volume here to persist files across restarts).
RUN mkdir -p workspace

EXPOSE 8787
CMD ["node", "dist/index.js"]
