# Build stage: compile TypeScript. No browser needed yet, so a plain slim Node image is enough.
FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: Playwright's official image ships Chromium plus every system library it
# needs to run headless — avoids the usual "missing shared library" debugging that comes
# from installing Chromium's dependencies by hand on a generic base image (ADR-0001).
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
WORKDIR /app

# The Playwright image's bundled Node version tracks Playwright's own release cadence,
# not this project's requirements (native node:sqlite, etc.) — pin a known-good Node
# explicitly rather than relying on whatever the base image happens to ship.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV PORT=3000 \
    DOWNLOADS_DIR=/data/downloads \
    DB_PATH=/data/db/ditch.sqlite

EXPOSE 3000
CMD ["node", "dist/server.js"]
