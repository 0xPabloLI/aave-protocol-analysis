// src/cli.ts
import { runMarketsFetcher } from "@internal/aave-fetcher";
async function main() {
  try {
    await runMarketsFetcher();
  } catch (error) {
    console.error("\u274C Failed to fetch Aave markets:", error);
    process.exit(1);
  }
  process.exit(0);
}
main();
//# sourceMappingURL=cli.js.map