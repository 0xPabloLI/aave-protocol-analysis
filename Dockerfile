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

# --max-old-space-size=768: GC triggers at 768MB, 75% of 1GB Railway container
# --expose-gc: expose globalThis.gc() for manual GC triggering in diagnostics
CMD ["node", "--max-old-space-size=768", "--expose-gc", "backend/dist/server.js"]