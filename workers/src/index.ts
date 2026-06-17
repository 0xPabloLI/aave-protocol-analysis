import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import { BrowserPool } from './browser-pool.js';

export interface Env {
  MY_BROWSER: BrowserWorker;
  BROWSER_POOL: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/limits') {
      try {
        const limits = await (puppeteer as any).limits(env.MY_BROWSER);
        return new Response(JSON.stringify({ success: true, limits }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }
    const id = env.BROWSER_POOL.idFromName('global-browser-pool');
    const stub = env.BROWSER_POOL.get(id);
    return await stub.fetch(request);
  },
};

export { BrowserPool };
