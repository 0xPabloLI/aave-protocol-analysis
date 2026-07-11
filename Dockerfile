# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Install all workspace dependencies (including devDependencies for TypeScript compilation)
# HUSKY=0 prevents husky from trying to install git hooks in Docker (no .git)
COPY package*.json ./
COPY packages/ ./packages/
COPY backend/package*.json ./backend/
COPY scripts/ ./scripts/
RUN HUSKY=0 npm ci

# Copy root source and build
COPY src/ ./src/
COPY tsconfig.json ./
# Validate non-TS packages (aave-shared-config ships raw .js, not compiled)
RUN node --check packages/aave-shared-config/index.js
RUN npm run build

# Copy backend source and build
COPY backend/src/ ./backend/src/
COPY backend/scripts/ ./backend/scripts/
COPY backend/tsconfig.json ./backend/
RUN mkdir -p backend/static
RUN npm run build -w aave-dashboard-backend

# Stage 2: Production
FROM node:20-slim

# Install Playwright Chromium system dependencies
RUN npx -y playwright install --with-deps chromium

WORKDIR /app

# Set production environment (also gates Console transport in logger)
ENV NODE_ENV=production

# Install production-only dependencies
COPY package*.json ./
COPY packages/ ./packages/
COPY backend/package*.json ./backend/
COPY scripts/ ./scripts/
RUN HUSKY=0 npm ci --omit=dev -w aave-dashboard-backend

# Copy compiled output from builder
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/packages/aave-shared-contracts/dist/ ./packages/aave-shared-contracts/dist/
COPY --from=builder /app/packages/aave-rpc-infra/dist/ ./packages/aave-rpc-infra/dist/
COPY --from=builder /app/packages/aave-fetcher/dist/ ./packages/aave-fetcher/dist/
COPY --from=builder /app/backend/dist/ ./backend/dist/
COPY --from=builder /app/backend/static/ ./backend/static/

# Copy migrations for auto-migration on startup
COPY backend/migrations/ ./backend/migrations/

# Create data and logs directories
RUN mkdir -p data logs backend/logs

EXPOSE 3001

# MALLOC_ARENA_MAX=2: limit glibc malloc arenas to reduce memory fragmentation.
# Default is 8×CPU cores, each arena holds independent memory pools that can't be
# returned to OS. On 1GB Railway container, this fragmentation causes RSS to grow
# ~30MB/h even though V8 heap is stable. Limiting to 2 arenas trades some
# throughput for much lower RSS growth.
ENV MALLOC_ARENA_MAX=2

# --max-old-space-size=512: V8 GC trigger threshold.
# Was 768MB (too permissive — old_space grew 22MB/h unchecked), then 384MB
# (caused OOM when heap reached 307MB + heap snapshot overhead pushed past 384MB).
# 512MB ≈ 3× steady-state heap (~95MB), forces GC well before 1GB RSS limit
# while leaving headroom for temporary allocations.
# --heapsnapshot-near-heap-limit: REMOVED — in 1GB containers, V8's auto-snapshot
# on OOM allocates ~2x heap memory instantly, causing a vertical RSS spike that
# guarantees OOM rather than preventing it. Only safe in ≥2GB containers.
CMD ["node", "--max-old-space-size=512", "backend/dist/server.js"]