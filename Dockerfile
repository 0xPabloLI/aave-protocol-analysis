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

# Copy backend source, static assets, and build
COPY backend/src/ ./backend/src/
COPY backend/scripts/ ./backend/scripts/
COPY backend/static/ ./backend/static/
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

# MALLOC_ARENA_MAX: limit glibc malloc arenas to reduce memory fragmentation.
# Default 2 is optimised for 1 GB containers (staging). Override via Railway env
# for larger containers (e.g. 4 for 2 GB production).
ENV MALLOC_ARENA_MAX=${MALLOC_ARENA_MAX:-2}

# V8 and Node flags — defaults tuned for 1 GB staging container.
# Override NODE_OPTIONS in Railway to customise per environment:
#   staging (1 GB): leave unset → defaults apply (--max-old-space-size=512)
#   production (2 GB): set NODE_OPTIONS="--max-old-space-size=1024"
CMD exec node ${NODE_OPTIONS:---max-old-space-size=512} backend/dist/server.js