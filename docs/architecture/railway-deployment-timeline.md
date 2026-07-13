# Railway Deployment Timeline

This shows why a Railway deploy rebuilds both the repository root and `backend/`.

```mermaid
flowchart LR
    A[Railway reads railway.json] --> B[Repo-root Dockerfile]
    B --> C[Build / and /backend]
    C --> D[Runtime loads @internal/aave-fetcher]
```

## What This Means

- `railway.json` tells Railway to build from the repo-root `Dockerfile`.
- The `Dockerfile` runs `npm run build` in the root stage and again in the `backend` stage.
- `backend/src/services/marketsService.ts` imports from `@internal/aave-fetcher`.

So when `packages/aave-fetcher/src/index.ts` changes, a Railway redeploy rebuilds the root output and the backend output together.
