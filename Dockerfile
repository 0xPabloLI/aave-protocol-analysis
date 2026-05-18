# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Install all workspace dependencies (including devDependencies for TypeScript compilation)
COPY package*.json ./
COPY packages/ ./packages/
COPY backend/package*.json ./backend/
COPY scripts/ ./scripts/
RUN npm ci

# Copy root source and build
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Copy backend source and build
COPY backend/src/ ./backend/src/
COPY backend/tsconfig.json ./backend/
RUN npm run build -w aave-dashboard-backend

# Stage 2: Production
FROM node:20-slim

# Install Puppeteer/Chromium system dependencies (needed by fetcher package at runtime)
# Split into two RUN commands to avoid OOM in Railway's build environment
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production-only dependencies
COPY package*.json ./
COPY packages/ ./packages/
COPY backend/package*.json ./backend/
COPY scripts/ ./scripts/
RUN npm ci --omit=dev -w aave-dashboard-backend

# Copy compiled output from builder
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/packages/aave-shared-contracts/dist/ ./packages/aave-shared-contracts/dist/
COPY --from=builder /app/packages/aave-fetcher/dist/ ./packages/aave-fetcher/dist/
COPY --from=builder /app/backend/dist/ ./backend/dist/

# Copy migrations for auto-migration on startup
COPY backend/migrations/ ./backend/migrations/

# Create data and logs directories
RUN mkdir -p data logs backend/logs

EXPOSE 3001

CMD ["node", "backend/dist/server.js"]