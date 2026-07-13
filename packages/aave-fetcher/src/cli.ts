import './env.js';
import { logger } from './logger.js';

async function main() {
  const { runMarketsFetcher } = await import('./index.js');

  try {
    await runMarketsFetcher();
  } catch (error) {
    logger.error('❌ Failed to fetch Aave markets:', error);
    process.exit(1);
  }

  try {
    const { closeBrowser } = await import('./merit-api.js');
    await closeBrowser().catch((err) => {
      logger.warn('⚠️ Error when closing browser:', err);
    });
  } catch {
  }

  process.exit(0);
}

main();