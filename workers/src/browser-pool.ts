import puppeteer, { type Browser, type BrowserWorker } from '@cloudflare/puppeteer';

export interface Env {
  MY_BROWSER: BrowserWorker;
  BROWSER_CONCURRENCY?: string;
  BROWSER_MAX_IDLE_MS?: string;
  BROWSER_MIN_LAUNCH_INTERVAL_MS?: string;
  BROWSER_REQUEST_TIMEOUT_MS?: string; // 请求超时时间（毫秒），默认 60 秒
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
    // 检查错误代码
    if ((error as any).code === 429) {
      return true;
    }
    // 检查错误消息
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
  // Track how many requests are currently using the SAME browser instance
  // Note: This counts REQUESTS, not browser instances or pages
  // - Each request creates its own page (session) from the same browser instance
  // - browserRefCount tracks how many requests are sharing the same browser instance
  // - When browserRefCount === 0, it means no requests are using the browser, so we can close it
  private browserRefCount = 0;

  private readonly defaultConcurrency = 2;
  private readonly defaultMaxIdleMs = 600000;
  private readonly defaultMinLaunchIntervalMs = 60000;
  // Cloudflare Free Plan: 3 new browser instances per minute (sliding window)
  private readonly maxLaunchesPerMinute = 3;
  // 请求超时时间（毫秒），防止请求卡死导致 browserRefCount 永远不减少
  // 注意：这个超时应该小于 Node.js 应用层的超时（30秒），以便 Worker 能先返回错误
  // 如果 Worker 超时时间大于应用层超时，应用层会先超时，看不到 Worker 返回的 429 错误
  private readonly defaultRequestTimeoutMs = 25000; // 25 秒（小于应用层的 30 秒）

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
          // 如果等待时间会超过请求超时时间，立即返回 429 错误，而不是等待
          // 这样可以确保 Node.js 应用层能看到 429 错误，而不是超时
          const requestTimeoutMs = Number(this.env.BROWSER_REQUEST_TIMEOUT_MS ?? this.defaultRequestTimeoutMs);
          if (waitMs > requestTimeoutMs * 0.8) { // 如果等待时间超过超时时间的 80%，立即返回错误
            const error = new Error(`Rate limit exceeded: ${this.launchHistory.length} launches in last minute (limit: ${this.maxLaunchesPerMinute}). Would need to wait ${Math.round(waitMs / 1000)}s, but request timeout is ${Math.round(requestTimeoutMs / 1000)}s`);
            (error as any).code = 429;
            throw error;
          }
          
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
        // 如果等待时间会超过请求超时时间，立即返回错误，而不是等待
        const requestTimeoutMs = Number(this.env.BROWSER_REQUEST_TIMEOUT_MS ?? this.defaultRequestTimeoutMs);
        if (intervalWaitMs > requestTimeoutMs * 0.8) {
          const error = new Error(`Minimum interval not met: need to wait ${Math.round(intervalWaitMs / 1000)}s, but request timeout is ${Math.round(requestTimeoutMs / 1000)}s`);
          (error as any).code = 429;
          throw error;
        }
        
        console.log(`[browser-pool] ⏸️ MIN INTERVAL WAIT: ${Math.round(intervalWaitMs / 1000)}s (minInterval: ${minIntervalMs}ms)`);
        await sleep(intervalWaitMs);
      }

      console.log(`[browser-pool] 🚀 ATTEMPTING TO LAUNCH NEW BROWSER INSTANCE...`);
      console.log(`[browser-pool]    • This will be launch #${this.totalLaunches + 1} (lifetime)`);
      console.log(`[browser-pool]    • Current launches in last minute: ${this.launchHistory.length}`);
      
      const launchAttemptTime = Date.now();
      // 不使用 keep_alive，使用默认的 60 秒空闲超时
      // 这样可以避免占用 10 分钟/天的配额
      // 如果需要更长的空闲时间，可以通过 scheduleIdleClose() 配置 BROWSER_MAX_IDLE_MS
      const browser = await puppeteer.launch(this.env.MY_BROWSER);
      
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
        console.log(`[browser-pool] 🔒 Closing browser instance...`);
        await this.browser.close();
        console.log(`[browser-pool] ✅ Browser closed successfully`);
      } catch (error) {
        console.log(`[browser-pool] ⚠️ Error closing browser: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.browser = null;
        this.lastUsedAt = 0;
        this.browserRefCount = 0; // 重置引用计数
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
    // 增加 browser 引用计数
    // 注意：browserRefCount 跟踪的是有多少个 REQUEST 正在使用同一个 browser instance
    // - 每个 request 会创建自己的 page（session），但共享同一个 browser instance
    // - browserRefCount 不是计算 browser instance 的数量（this.browser 只有一个）
    // - browserRefCount 是计算同一个 browser instance 里面的不同 request
    this.browserRefCount++;
    let page: any = null;
    
    // 设置请求超时，防止请求卡死导致 browserRefCount 永远不减少
    const requestTimeoutMs = Number(this.env.BROWSER_REQUEST_TIMEOUT_MS ?? this.defaultRequestTimeoutMs);
    const requestStartTime = Date.now();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let requestTimedOut = false;

    try {
      // 验证 action 是否有效（在创建 page 之前验证，避免浪费资源）
      const validActions = ['extractCampaignInfo', 'extractSelfAuth', 'extractDynamicInfo'];
      if (!validActions.includes(action)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Valid actions are: ${validActions.join(', ')}`,
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // 设置超时保护：如果请求超过指定时间，强制抛出超时错误
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          requestTimedOut = true;
          const elapsed = Date.now() - requestStartTime;
          reject(new Error(`Request timeout after ${elapsed}ms (limit: ${requestTimeoutMs}ms)`));
        }, requestTimeoutMs);
      });
      
      // 使用 Promise.race 确保超时后能立即中断
      const result = await Promise.race([
        (async () => {
          page = await browser.newPage();
          await page.setViewport({ width: 1920, height: 1080 });
          await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          );

          const url = `https://apps.aavechan.com/merit/${key}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
          await page.waitForSelector('body', { timeout: 10000 });
          await sleep(1000);

          let extractResult: any;
          if (action === 'extractCampaignInfo') {
            extractResult = await extractCampaignInfo(page);
          } else if (action === 'extractSelfAuth') {
            extractResult = await extractSelfAuth(page);
          } else if (action === 'extractDynamicInfo') {
            const [campaignInfo, selfAuthDescription] = await Promise.all([
              extractCampaignInfo(page),
              extractSelfAuth(page),
            ]);
            extractResult = { campaignInfo, selfAuthDescription };
          }

          this.lastUsedAt = Date.now();
          // 取消超时定时器（请求成功完成）
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          
          return extractResult;
        })(),
        timeoutPromise,
      ]);
      
      // 不再使用 scheduleIdleClose()，因为用户只有一个 worker，不需要复用 browser
      // 每次请求完成后，如果所有请求都完成了，就关闭 browser
      return new Response(JSON.stringify({ success: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // 取消超时定时器（如果还在运行）
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      
      this.totalErrors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // 检查是否是未知 action 错误，返回 400 而不是 500
      const isUnknownAction = errorMessage.includes('Unknown action');
      const statusCode = isUnknownAction ? 400 : 500;
      
      // 如果是超时错误，记录更详细的信息
      if (requestTimedOut) {
        const elapsed = Date.now() - requestStartTime;
        console.log(`[browser-pool] ⏱️ Request ${requestId} TIMED OUT after ${elapsed}ms (limit: ${requestTimeoutMs}ms)`);
        console.log(`[browser-pool] ⚠️ This request will be cleaned up in finally block to prevent browserRefCount leak`);
      }
      
      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        timedOut: requestTimedOut,
      }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
    } finally {
      // ============================================
      // 请求完成的判断标准：
      // 1. 所有异步操作完成（extractCampaignInfo, extractSelfAuth 等）
      // 2. HTTP 响应已返回（return new Response）
      // 3. 请求超时（timeout）
      // 4. 无论成功、失败还是超时，finally 块都会执行
      // ============================================
      
      // 确保超时定时器被清除
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      
      // 先关闭 page（释放页面资源）
      // 注意：即使请求超时，也要关闭 page，防止资源泄漏
      if (page) {
        try {
          await page.close();
          console.log(`[browser-pool] ✅ Page closed for request ${requestId}${requestTimedOut ? ' (timed out)' : ''}`);
        } catch (error) {
          console.log(`[browser-pool] ⚠️ Error closing page: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // 减少 browser 引用计数
      // 注意：无论请求成功还是失败，都要减少计数
      // 这表示"这个请求已经完成，不再使用 browser instance"
      // browserRefCount 跟踪的是有多少个 REQUEST 正在使用同一个 browser instance
      // 不是计算 browser instance 的数量，而是计算同一个 browser instance 里面的不同 request
      this.browserRefCount--;
      console.log(`[browser-pool] 📊 Request ${requestId} completed, browserRefCount=${this.browserRefCount} (requests using same browser instance)`);
      
      // 释放 semaphore（允许下一个请求开始）
      release();
      
      // 如果所有请求都完成了（引用计数为 0），关闭 browser
      // 判断标准：
      // 1. browserRefCount === 0：没有其他请求正在使用这个 browser instance
      //    - browserRefCount 跟踪的是有多少个 REQUEST 正在使用同一个 browser instance
      //    - 不是计算 browser instance 的数量，而是计算同一个 browser instance 里面的不同 request
      // 2. this.browser === browser：确保 browser 还是同一个实例（避免关闭其他请求创建的 browser）
      if (this.browserRefCount === 0 && this.browser === browser) {
        try {
          console.log(`[browser-pool] 🔒 All requests completed (refCount=0), closing browser...`);
          await this.closeBrowser();
        } catch (error) {
          console.log(`[browser-pool] ⚠️ Error closing browser: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (this.browserRefCount > 0) {
        console.log(`[browser-pool] ℹ️ Request ${requestId} completed, but browser still in use (refCount=${this.browserRefCount})`);
      } else if (this.browser !== browser) {
        console.log(`[browser-pool] ℹ️ Request ${requestId} completed, but browser instance changed (new browser created by another request)`);
      }
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

    // 使用箭头函数避免 TypeScript 编译引入 __name 等辅助变量
    const norm = (s: any) => {
      return String(s || '').replace(/\s+/g, ' ').trim();
    };

    const hasSelfAuth = (s: any) => {
      const t = String(s || '').toLowerCase();
      return t.includes('self') && (t.includes('authentication') || t.includes('verify') || t.includes('proof'));
    };

    const scoreEl = (el: any) => {
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
