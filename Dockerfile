# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Copy workspace root package.json + lockfile + all packages
COPY package*.json ./
COPY packages/ ./packages/
COPY backend/package*.json ./backend/

# Install ALL dependencies (workspace-aware, single npm ci for root + packages + backend)
RUN npm ci

# Copy all source files
COPY tsconfig.json ./
COPY src/ ./src/
COPY backend/tsconfig.json ./backend/
COPY backend/src/ ./backend/src/

# Build in dependency order
RUN npm run build -w @internal/aave-shared-contracts
RUN npm run build -w @internal/aave-fetcher
RUN npm run build
RUN npm run build -w aave-dashboard-backend

# Stage 2: Production
FROM node:20-slim

# Install Puppeteer/Chromium system dependencies (needed by fetcher package at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace root package.json + lockfile + all package manifests
COPY package*.json ./
COPY packages/ ./packages/
COPY backend/package*.json ./backend/

# Install production-only dependencies (workspace-aware)
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/packages/aave-shared-contracts/dist/ ./packages/aave-shared-contracts/dist/
COPY --from=builder /app/packages/aave-fetcher/dist/ ./packages/aave-fetcher/dist/
COPY --from=builder /app/backend/dist/ ./backend/dist/

# Create data and logs directories
RUN mkdir -p data logs backend/logs

EXPOSE 3001

CMD ["node", "backend/dist/server.js"]