import type { BrowserWorker } from '@cloudflare/puppeteer';
import { BrowserPool } from './browser-pool.js';

export interface Env {
  MY_BROWSER: BrowserWorker;
  BROWSER_POOL: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.BROWSER_POOL.idFromName('global-browser-pool');
    const stub = env.BROWSER_POOL.get(id);
    return await stub.fetch(request);
  },
};

export { BrowserPool };
