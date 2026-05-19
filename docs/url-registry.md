# URL Registry

All URLs used across the project, centralized for reference and maintenance.

## 1. Deployment Domains

| Environment | Backend API | Frontend | CI Branch |
|---|---|---|---|
| production | `https://api.aaveapy.com` | `https://aaveapy.com` | `main` |
| staging | `https://staging-api.aaveapy.com` | `https://staging.aaveapy.com` | `railway` |
| lovable preview | — | `https://aaveapy.lovable.app` | — |
| local dev | `http://localhost:3001` | `http://localhost:5173` | — |

- Source: `.github/scripts/deployment-smoke-test-helpers.mjs`, `docs/ci-security-automation.md`
- Healthcheck: `curl https://staging-api.aaveapy.com/health`

## 2. Backend API Routes

| Path | Method | Handler | Auth |
|---|---|---|---|
| `/health` | GET | inline | none |
| `/api/health` | GET | inline | none |
| `/api/markets` | GET | `routes/markets.ts` | none |
| `/api/meta/side-data` | GET | `routes/meta.ts` | none |
| `/api/seo/status` | GET | `routes/seo.ts` | SEO auth |
| `/api/seo/gsc` | GET | `routes/seo.ts` | SEO auth |
| `/api/seo/semrush` | GET | `routes/seo.ts` | SEO auth |
| `/api/seo/semrush` | POST | `routes/seo.ts` | SEO auth |
| `/api/seo/semrush/batch` | POST | `routes/seo.ts` | SEO auth |
| `/api/seo/semrush/:id` | DELETE | `routes/seo.ts` | SEO auth |
| `/api/persistence-status` | GET | inline | none |
| `/.well-known/security.txt` | GET | inline | none |

- Source: `backend/src/server.ts`
- Full docs: `docs/api/api-documentation.md`, `docs/api/seo-api-documentation.md`

## 3. External Data Sources (Upstream APIs)

### Incentive Protocols

| Service | URL | Used In |
|---|---|---|
| Merit APR | `https://apps.aavechan.com/api/merit/aprs` | `packages/aave-fetcher/src/merit-api.ts` |
| Merit Activity | `https://apps.aavechan.com/merit/{key}` | `packages/aave-fetcher/src/merit-api.ts` |
| Merkl API V4 | `https://api.merkl.xyz/v4` | `packages/aave-fetcher/src/merkl-api.ts`, `backend/src/services/merklForecastService.ts` |
| Merkl Campaign | `https://api.merkl.xyz/v4/campaigns/{campaignId}` | `packages/aave-fetcher/src/merkl-api.ts` |
| Merkl Opportunities | `https://api.merkl.xyz/v4/opportunities?mainProtocolId=aave` | `packages/aave-fetcher/src/merkl-api.ts` |
| Merkl Frontend | `https://app.merkl.xyz/opportunities/{chain}/{type}/{id}` | `packages/aave-fetcher/src/merkl-api.ts` |
| Brevis Frontend | `https://incentra.brevis.network` | `packages/aave-fetcher/src/brevis-api.ts` |
| Brevis gRPC | `https://incentra-prd.brevis.network` | `packages/aave-fetcher/src/brevis-api.ts` |
| Brevis Campaign Link | `https://incentra.brevis.network/campaign/?pool_id={id}&type={type}&chainId={chainId}` | `docs/api/brevis-supplement.md` |

### Price & Market Data

| Service | URL | Used In |
|---|---|---|
| CoinGecko API | `https://api.coingecko.com/api/v3` | `packages/aave-fetcher/src/token-price-resolver.ts` |
| CoinGecko Markets | `https://api.coingecko.com/api/v3/coins/markets` | `backend/src/controllers/coingeckoController.ts` |
| CoinGecko Asset Platforms | `https://api.coingecko.com/api/v3/asset_platforms` | `packages/aave-fetcher/src/generated/coingecko-platform-by-chain-id.ts` |
| CoinMarketCap | `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest` | `backend/src/controllers/coingeckoController.ts` |

### External Docs

| Resource | URL |
|---|---|
| Merkl Mechanisms | `https://docs.merkl.xyz/merkl-mechanisms/incentive-mechanisms` |
| Merkl Distributions | `https://docs.merkl.xyz/merkl-mechanisms/distributions` |
| Merkl Integrate | `https://docs.merkl.xyz/integrate-merkl/app` |
| Brevis Docs | `https://incentra-docs.brevis.network` |
| Brevis SDK | `https://incentra-docs.brevis.network/developer-sdk/get-campaigns` |
| Cloudflare Browser Rendering | `https://developers.cloudflare.com/browser-rendering/limits/` |

## 4. RPC Endpoints

Full list in `docs/backend/rpc-endpoints.md` and `packages/aave-shared-config/index.js`.

### Public RPCs (selected)

| Chain | chainId | Primary RPC |
|---|---|---|
| Ethereum | 1 | `ethereum-rpc.publicnode.com` |
| Polygon | 137 | `polygon-bor-rpc.publicnode.com` |
| Avalanche | 43114 | `api.avax.network/ext/bc/C/rpc` |
| Arbitrum | 42161 | `arb1.arbitrum.io/rpc` |
| Base | 8453 | `base.publicnode.com` |
| Optimism | 10 | `optimism-rpc.publicnode.com` |
| Metis | 1088 | `andromeda.metis.io/?owner=1088` |
| Gnosis | 100 | `gnosis-rpc.publicnode.com` |
| BNB | 56 | `bsc.publicnode.com` |
| Scroll | 534352 | `rpc.scroll.io` |
| zkSync | 324 | `mainnet.era.zksync.io` |
| Linea | 59144 | `rpc.linea.build` |
| Sonic | 146 | `rpc.soniclabs.com` |
| Celo | 42220 | `forno.celo.org` |
| Soneium | 1868 | `rpc.soneium.org` |
| Mantle | 5000 | `rpc.mantle.xyz` |
| Berachain | 80094 | `rpc.berachain.com` |

### Private RPC Templates

- Infura: `https://mainnet.infura.io/v3/${INFURA_PROJECT_ID}`
- Alchemy: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`

## 5. Frontend Deeplinks (Aave UI)

| Target | URL Pattern | Source |
|---|---|---|
| V3 Reserve | `https://app.aave.com` + path | `docs/changes/pro-aave-v4-deeplinks.md` |
| V4 Hub | `https://pro.aave.com/explore/hub/{hubId}` | `docs/api/FRONTEND-SYNC-CHANGES.md` |
| V4 Reserve | `https://pro.aave.com/explore/reserve/{aaveProReserveId}` | `docs/api/FRONTEND-SYNC-CHANGES.md` |
| V4 Asset | `https://pro.aave.com/explore/asset/{chainId}/{address}` | `docs/changes/pro-aave-v4-deeplinks.md` |

## 6. SEO / i18n Page Routes

| Locale | Path | Language |
|---|---|---|
| default (US) | `/` | en |
| Brazil | `/pt-br` | pt-BR |
| France | `/fr` | fr |
| Turkey | `/tr` | tr |
| Germany (planned) | `/de` | de |

- Source: `docs/plans/keyword-plan.md`
- security.txt: `https://aaveapy.com/.well-known/security.txt`

## 7. CORS Allowed Origins

| Environment Variable | Typical Value | Purpose |
|---|---|---|
| `FRONTEND_URL` | `https://aaveapy.com` (prod), `https://staging.aaveapy.com` (staging) | Primary frontend |
| `SEO_ALLOWED_ORIGINS` | `https://aaveapy.lovable.app` | SEO admin (Lovable) |
| `ALLOWED_DEV_ORIGINS` | `http://localhost:5173` | Local dev |

- Source: `backend/src/middleware/cors.ts`, `backend/src/middleware/corsOrigin.ts`

## 8. Infrastructure URLs

| Resource | URL / Pattern | Source |
|---|---|---|
| Railway GraphQL API | `${RAILWAY_API_URL}` | `.github/workflows/deployment-smoke-test.yml` |
| R2 Backup Endpoint | `${R2_ENDPOINT}` (e.g. `https://<account-id>.r2.cloudflarestorage.com`) | `.github/workflows/db-backup.yml` |
| Cloudflare Worker | `${CLOUDFLARE_WORKER_URL}` | `docs/deploy/cloudflare-complete-guide.md` |
