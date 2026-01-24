import puppeteer, { type Browser, type BrowserWorker } from '@cloudflare/puppeteer';

export interface Env {
  MY_BROWSER: BrowserWorker;
  BROWSER_CONCURRENCY?: string;
  BROWSER_MAX_IDLE_MS?: string;
  BROWSER_MIN_LAUNCH_INTERVAL_MS?: string;
}

interface RequestBody {
  action: 'extractCampaignInfo' | 'extractSelfAuth' | 'extractDynamicInfo' | 'debugSessions' | 'closeBrowserInstances' | 'getStats';
  key?: string;
}

interface CampaignInfo {
  action?: string;
  description?: string;
}

interface Semaphore {
  acquire(): Promise<() => void>;
}

function createSemaphore(concurrency: number): Semaphore {
  let available = concurrency;
  const queue: Array<() => void> = [];

  return {
    async acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        if (available > 0) {
          available--;
          resolve(() => {
            available++;
            const next = queue.shift();
            if (next) next();
          });
        } else {
          queue.push(() => {
            available--;
            resolve(() => {
              available++;
              const next = queue.shift();
              if (next) next();
            });
          });
        }
      });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('quota exceeded')
    );
  }
  return false;
}

function getRetryAfterMs(error: unknown, defaultMs: number): number {
  if (error instanceof Error) {
    const match = error.message.match(/retry[-\s]after[:\s]+(\d+)/i);
    if (match) {
      return Number(match[1]) * 1000;
    }
  }
  return defaultMs;
}

export class BrowserPool {
  private state: DurableObjectState;
  private env: Env;
  private browser: Browser | null = null;
  private browserLaunchPromise: Promise<Browser> | null = null;
  private lastLaunchAt = 0;
  private lastUsedAt = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private semaphore: Semaphore;
  // Track launch timestamps for sliding window rate limiting (per-minute limit)
  private launchHistory: number[] = [];

  private readonly defaultConcurrency = 2;
  private readonly defaultMaxIdleMs = 600000;
  private readonly defaultMinLaunchIntervalMs = 60000;
  // Cloudflare Free Plan: 3 new browser instances per minute (sliding window)
  private readonly maxLaunchesPerMinute = 3;

  private totalRequests = 0;
  private totalLaunches = 0;
  private totalReuses = 0;
  private totalErrors = 0;
  private total429s = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    const concurrency = Number(env.BROWSER_CONCURRENCY ?? this.defaultConcurrency);
    this.semaphore = createSemaphore(concurrency);
  }

  private scheduleIdleClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
    }

    const maxIdleMs = Number(this.env.BROWSER_MAX_IDLE_MS ?? this.defaultMaxIdleMs);
    this.closeTimer = setTimeout(async () => {
      const idleMs = Date.now() - this.lastUsedAt;
      if (idleMs >= maxIdleMs && this.browser) {
        await this.closeBrowser();
      }
    }, maxIdleMs);
  }

  private async connectToExistingSession(): Promise<Browser | null> {
    try {
      const puppeteerWithSessions = puppeteer as any;
      if (typeof puppeteerWithSessions.sessions !== 'function' || typeof puppeteerWithSessions.connect !== 'function') {
        return null;
      }

      const sessions = await puppeteerWithSessions.sessions(this.env.MY_BROWSER);
      if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
        return null;
      }

      const session = sessions[Math.floor(Math.random() * sessions.length)];
      const sessionId = (session as any).sessionId || (session as any).id;
      if (!sessionId) return null;

      const browser = await puppeteerWithSessions.connect(this.env.MY_BROWSER, sessionId);
      return browser as Browser;
    } catch {
      return null;
    }
  }

  private async getBrowser(): Promise<Browser> {
    console.log(`[browser-pool] 📞 getBrowser() called (browserActive: ${this.browser !== null})`);
    
    if (this.browser) {
      try {
        await this.browser.pages();
        this.lastUsedAt = Date.now();
        this.totalReuses++;
        console.log(`[browser-pool] ✅ REUSED IN-MEMORY BROWSER (total reuses: ${this.totalReuses})`);
        return this.browser;
      } catch (error) {
        console.log(`[browser-pool] ⚠️ In-memory browser disconnected: ${error instanceof Error ? error.message : String(error)}`);
        this.browser = null;
      }
    }

    if (this.browserLaunchPromise) {
      console.log(`[browser-pool] ⏳ Browser launch already in progress, waiting...`);
      return await this.browserLaunchPromise;
    }

    console.log(`[browser-pool] 🔄 Attempting to connect to existing session...`);
    const existing = await this.connectToExistingSession();
    if (existing) {
      console.log(`[browser-pool] ✅ REUSED EXISTING SESSION (total reuses: ${this.totalReuses + 1})`);
      this.browser = existing;
      this.lastUsedAt = Date.now();
      this.totalReuses++;
      return existing;
    }
    console.log(`[browser-pool] ℹ️ No existing session found, will launch new browser`);

    this.browserLaunchPromise = (async () => {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      
      console.log(`[browser-pool] 🔍 PRE-LAUNCH CHECK:`);
      console.log(`[browser-pool]    • Current time: ${new Date(now).toISOString()}`);
      console.log(`[browser-pool]    • Launch history (raw): ${JSON.stringify(this.launchHistory.map(t => new Date(t).toISOString()))}`);
      
      // Clean up old launch history (older than 1 minute)
      this.launchHistory = this.launchHistory.filter(timestamp => timestamp > oneMinuteAgo);
      
      console.log(`[browser-pool]    • Launch history (after cleanup): ${this.launchHistory.length} launches in last 60s`);
      console.log(`[browser-pool]    • Last launch at: ${this.lastLaunchAt > 0 ? new Date(this.lastLaunchAt).toISOString() : 'never'}`);
      console.log(`[browser-pool]    • Time since last launch: ${this.lastLaunchAt > 0 ? Math.round((now - this.lastLaunchAt) / 1000) : 'N/A'}s`);
      console.log(`[browser-pool]    • Total launches (lifetime): ${this.totalLaunches}`);
      console.log(`[browser-pool]    • Total reuses (lifetime): ${this.totalReuses}`);
      
      // Check if we've hit the per-minute limit (sliding window)
      if (this.launchHistory.length >= this.maxLaunchesPerMinute) {
        // Calculate wait time until the oldest launch is 1 minute old
        const oldestLaunch = Math.min(...this.launchHistory);
        const waitMs = Math.max(0, oldestLaunch + 60000 - now + 1000); // +1s safety margin
        if (waitMs > 0) {
          console.log(`[browser-pool] ⏸️ RATE LIMIT PROTECTION: ${this.launchHistory.length} launches in last minute (limit: ${this.maxLaunchesPerMinute})`);
          console.log(`[browser-pool]    • Oldest launch: ${new Date(oldestLaunch).toISOString()}`);
          console.log(`[browser-pool]    • Waiting ${Math.round(waitMs / 1000)}s until oldest launch is >60s old`);
          await sleep(waitMs);
          // Re-clean after waiting
          const newNow = Date.now();
          const newOneMinuteAgo = newNow - 60000;
          this.launchHistory = this.launchHistory.filter(timestamp => timestamp > newOneMinuteAgo);
          console.log(`[browser-pool]    • After wait: ${this.launchHistory.length} launches in last minute`);
        }
      }

      // Also respect minimum interval between launches (safety margin)
      const minIntervalMs = Number(this.env.BROWSER_MIN_LAUNCH_INTERVAL_MS ?? this.defaultMinLaunchIntervalMs);
      const intervalWaitMs = Math.max(0, this.lastLaunchAt + minIntervalMs - Date.now());
      if (intervalWaitMs > 0) {
        console.log(`[browser-pool] ⏸️ MIN INTERVAL WAIT: ${Math.round(intervalWaitMs / 1000)}s (minInterval: ${minIntervalMs}ms)`);
        await sleep(intervalWaitMs);
      }

      console.log(`[browser-pool] 🚀 ATTEMPTING TO LAUNCH NEW BROWSER INSTANCE...`);
      console.log(`[browser-pool]    • This will be launch #${this.totalLaunches + 1} (lifetime)`);
      console.log(`[browser-pool]    • Current launches in last minute: ${this.launchHistory.length}`);
      
      const launchAttemptTime = Date.now();
      const browser = await puppeteer.launch(this.env.MY_BROWSER, {
        keep_alive: 600000, // 10 minutes (max allowed)
      } as any);
      
      // CRITICAL: Only update timestamps and history if launch succeeded
      this.lastLaunchAt = launchAttemptTime;
      this.launchHistory.push(this.lastLaunchAt);
      this.browser = browser;
      this.lastUsedAt = Date.now();
      this.totalLaunches++;
      
      console.log(`[browser-pool] ✅ BROWSER LAUNCHED SUCCESSFULLY`);
      console.log(`[browser-pool]    • Launch time: ${new Date(this.lastLaunchAt).toISOString()}`);
      console.log(`[browser-pool]    • Total launches (lifetime): ${this.totalLaunches}`);
      console.log(`[browser-pool]    • Launches in last minute: ${this.launchHistory.length}`);
      console.log(`[browser-pool]    • Browser active: true`);
      
      return browser;
    })();

    try {
      return await this.browserLaunchPromise;
    } finally {
      this.browserLaunchPromise = null;
    }
  }

  private async closeBrowser(): Promise<void> {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } finally {
        this.browser = null;
        this.lastUsedAt = 0;
      }
    }
  }

  private async closeAllSessions(): Promise<{ closed: number; errors: string[] }> {
    let closed = 0;
    const errors: string[] = [];
    try {
      const puppeteerWithSessions = puppeteer as any;
      if (typeof puppeteerWithSessions.sessions === 'function') {
        const sessions = await puppeteerWithSessions.sessions(this.env.MY_BROWSER);
        if (sessions && Array.isArray(sessions)) {
          for (const session of sessions) {
            const sessionId = (session as any).sessionId || (session as any).id;
            if (sessionId && typeof puppeteerWithSessions.connect === 'function') {
              try {
                const browser = await puppeteerWithSessions.connect(this.env.MY_BROWSER, sessionId);
                await browser.close();
                closed++;
              } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
              }
            }
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { closed, errors };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = await request.json() as RequestBody;
    const { action, key } = body;

    if (!action || (action !== 'debugSessions' && action !== 'closeBrowserInstances' && action !== 'getStats' && !key)) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: action, key' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'getStats') {
      let history = [];
      try {
        const puppeteerWithHistory = puppeteer as any;
        if (typeof puppeteerWithHistory.history === 'function') {
          history = await puppeteerWithHistory.history(this.env.MY_BROWSER);
        }
      } catch (e) {}

      return new Response(JSON.stringify({
        success: true,
        stats: {
          browserActive: this.browser !== null,
          lastLaunchAt: this.lastLaunchAt > 0 ? new Date(this.lastLaunchAt).toISOString() : null,
          lastUsedAt: this.lastUsedAt > 0 ? new Date(this.lastUsedAt).toISOString() : null,
          totalRequests: this.totalRequests,
          totalLaunches: this.totalLaunches,
          totalReuses: this.totalReuses,
          totalErrors: this.totalErrors,
          total429s: this.total429s,
          minLaunchIntervalMs: Number(this.env.BROWSER_MIN_LAUNCH_INTERVAL_MS ?? this.defaultMinLaunchIntervalMs),
          launchesInLastMinute: this.launchHistory.length,
          maxLaunchesPerMinute: this.maxLaunchesPerMinute,
          recentHistory: history.slice(0, 10),
        }
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (action === 'debugSessions') {
      try {
        const puppeteerWithSessions = puppeteer as any;
        const sessions = typeof puppeteerWithSessions.sessions === 'function'
          ? await puppeteerWithSessions.sessions(this.env.MY_BROWSER)
          : [];
        const sessionIds = Array.isArray(sessions)
          ? sessions.map((s: any) => (s as any).sessionId || (s as any).id || 'unknown')
          : [];
        return new Response(JSON.stringify({
          success: true,
          sessions: Array.isArray(sessions) ? sessions.length : 0,
          sessionIds,
          totalRequests: this.totalRequests,
          totalLaunches: this.totalLaunches,
          totalReuses: this.totalReuses,
          totalErrors: this.totalErrors,
          total429s: this.total429s,
          launchesInLastMinute: this.launchHistory.length,
          maxLaunchesPerMinute: this.maxLaunchesPerMinute,
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        this.totalErrors++;
        return new Response(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (action === 'closeBrowserInstances') {
      await this.closeBrowser();
      const { closed, errors } = await this.closeAllSessions();
      return new Response(JSON.stringify({
        success: true,
        closed,
        errors: errors.length > 0 ? errors : undefined,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!key) {
      return new Response(JSON.stringify({ error: 'Missing required field: key' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.totalRequests++;
    console.log(`[browser-pool] 📥 REQUEST ${requestId}: action=${action}, key=${key}`);
    
    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      console.log(`[browser-pool] ❌ Cloudflare Launch Error: ${rawError}`);
      
      // Return raw error directly to debug
      return new Response(JSON.stringify({
        success: false,
        error: rawError,
        isRateLimit: isRateLimitError(error),
      }), { 
        status: isRateLimitError(error) ? 429 : 500, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const release = await this.semaphore.acquire();
    let page: any = null;

    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      const url = `https://apps.aavechan.com/merit/${key}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector('body', { timeout: 10000 });
      await sleep(1000);

      let result: any;
      if (action === 'extractCampaignInfo') {
        result = await extractCampaignInfo(page);
      } else if (action === 'extractSelfAuth') {
        result = await extractSelfAuth(page);
      } else if (action === 'extractDynamicInfo') {
        const [campaignInfo, selfAuthDescription] = await Promise.all([
          extractCampaignInfo(page),
          extractSelfAuth(page),
        ]);
        result = { campaignInfo, selfAuthDescription };
      } else {
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      this.lastUsedAt = Date.now();
      this.scheduleIdleClose();
      return new Response(JSON.stringify({ success: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      this.totalErrors++;
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          // ignore
        }
      }
      release();
    }
  }
}

async function extractCampaignInfo(page: any): Promise<CampaignInfo[]> {
  try {
    const buttons = await page.$$('button');
    for (const button of buttons) {
      const text = await page.evaluate((el: any) => el?.textContent || '', button);
      if (text && /campaign\s+info/i.test(text)) {
        await button.click();
        await sleep(800);
        break;
      }
    }
  } catch {
    // ignore
  }

  try {
    const infoButtonIndex = await page.$$eval('button', (buttons: any[]) => {
      return buttons.findIndex((btn: any) => {
        const text = btn.textContent || '';
        return /info/i.test(text) && text.length < 50;
      });
    });
    if (infoButtonIndex >= 0) {
      const buttons = await page.$$('button');
      if (buttons[infoButtonIndex]) {
        await buttons[infoButtonIndex].click();
        await sleep(800);
      }
    }
  } catch {
    // ignore
  }

  return await page.evaluate(() => {
    const infos: CampaignInfo[] = [];
    const doc = (globalThis as any).document;
    if (!doc) return infos;

    const tables = doc.querySelectorAll('table');
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i] as any;
      const rows = table.querySelectorAll('tbody tr');
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j] as any;
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const action = (cells[0] as any)?.textContent?.trim() || '';
          const description = (cells[1] as any)?.textContent?.trim() || '';
          if (action.length > 0 && description.length > action.length && description.length > 20) {
            infos.push({ action, description });
          }
        }
      }
    }
    return infos;
  });
}

async function extractSelfAuth(page: any): Promise<string | null> {
  return await page.evaluate(() => {
    const doc = (globalThis as any).document;
    if (!doc) return null;

    function norm(s: any) {
      return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function hasSelfAuth(s: any) {
      const t = String(s || '').toLowerCase();
      return t.includes('self') && (t.includes('authentication') || t.includes('verify') || t.includes('proof'));
    }

    function scoreEl(el: any) {
      const text = norm(el?.textContent);
      if (!text || !hasSelfAuth(text)) return -1;
      let score = 0;
      if (text.length >= 60 && text.length <= 900) score += 3;
      if (text.toLowerCase().includes('supply')) score += 1;
      if (text.toLowerCase().includes('borrow')) score += 1;
      try {
        const cs = (globalThis as any).getComputedStyle(el);
        const bg = cs?.backgroundColor || '';
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') score += 2;
        const border = cs?.borderColor || '';
        if (border && border !== 'rgba(0, 0, 0, 0)' && border !== 'transparent') score += 1;
      } catch {}
      if (text.length > 900) score -= 3;
      return score;
    }

    try {
      const candidates = doc.querySelectorAll('section,article,aside,div,p,li') as any;

      let best: any = null;
      let bestScore = -1;
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        const s = scoreEl(el);
        if (s > bestScore) {
          bestScore = s;
          best = el;
        }
      }

      if (best) {
        let container: any = best;
        for (let i = 0; i < 4; i++) {
          const t = norm(container?.textContent);
          if (t.length >= 60 && t.length <= 900 && hasSelfAuth(t)) break;
          container = container?.parentElement;
          if (!container) break;
        }
        const finalText = norm(container?.textContent);
        if (finalText && hasSelfAuth(finalText) && finalText.length <= 1200) {
          return finalText.length > 950 ? finalText.slice(0, 950) : finalText;
        }
      }
    } catch {
      // ignore
    }

    const allElements = doc.querySelectorAll('*') as any;
    for (let i = 0; i < allElements.length; i++) {
      const element = allElements[i] as any;
      if (!element) continue;
      const text = norm(element.textContent || '');
      if (hasSelfAuth(text) && text.length > 60 && text.length < 1000) {
        return text;
      }
    }

    return null;
  });
}
