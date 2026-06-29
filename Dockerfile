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

# --max-old-space-size=384: force aggressive old_space GC to prevent ~23MB/h leak
# (768MB was too permissive — V8 didn't GC until approaching limit, allowing old_space
# to grow unchecked. 384MB ≈ 2× steady-state heap ~95MB, gives enough headroom while
# forcing GC before RSS reaches ~600MB where OOM risk is high on 1GB Railway container.)
# --expose-gc: expose globalThis.gc() for manual GC triggering in diagnostics
CMD ["node", "--max-old-space-size=384", "--expose-gc", "backend/dist/server.js"]