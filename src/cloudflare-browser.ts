import fetch from 'node-fetch';
import { logger } from './logger.js';
import { cloudflareWorkerConfig } from './config.js';
import type { MeritCampaignInfo } from './merit-api.js';

// Cloudflare Worker URL (set via environment variable)
// Example: https://aave-browser-rendering.your-subdomain.workers.dev
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cloudflare Browser Rendering limits (Workers Bindings):
// - New browser instances per minute: 3 on Workers Free -> ~1 request every 20s.
// See: https://developers.cloudflare.com/browser-rendering/limits/
const WORKER_DYNAMIC_MIN_INTERVAL_MS = cloudflareWorkerConfig.dynamicMinIntervalMs;
const WORKER_DYNAMIC_MAX_RETRIES = cloudflareWorkerConfig.dynamicMaxRetries;
const WORKER_DYNAMIC_CIRCUIT_BREAKER_MS = cloudflareWorkerConfig.dynamicCircuitBreakerMs;
const WORKER_DYNAMIC_FAIL_FAST = cloudflareWorkerConfig.dynamicFailFast;

let dynamicQueue: Promise<void> = Promise.resolve();
let lastDynamicStartedAt = 0;
let workerDisabledUntil = 0;
const MAX_ERROR_SNIPPET = 240;

// 全局请求计数器（用于监控）
let totalWorkerRequests = 0;
let totalWorker429s = 0;
let totalWorkerErrors = 0;
let appStartTime = Date.now();

// ============================================================================
// Global Semaphore for Worker Requests (Prevent Multiple Worker Instances)
// ============================================================================
// CRITICAL: Cloudflare Workers can have multiple instances.
// If we send 5 concurrent requests, they might route to 5 different Worker instances,
// each trying to create a browser instance → 429 error.
// Solution: Use a global semaphore to ensure only 1 request at a time.

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

// Global semaphore: Only 1 concurrent Worker request at a time
// This prevents multiple Worker instances from trying to create browsers simultaneously
const workerRequestSemaphore = createSemaphore(1);

function trimErrorSnippet(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_ERROR_SNIPPET ? `${cleaned.slice(0, MAX_ERROR_SNIPPET)}…` : cleaned;
}

/**
 * 获取 Worker 端的 session 统计信息
 */
export async function getWorkerSessionStats(): Promise<{
  success: boolean;
  sessions?: number;
  sessionIds?: string[];
  totalLaunches?: number;
  totalReuses?: number;
  totalDisconnects?: number;
  uptimeSeconds?: number;
  error?: string;
}> {
  if (!CLOUDFLARE_WORKER_URL) {
    return { success: false, error: 'CLOUDFLARE_WORKER_URL not set' };
  }

  try {
    const response = await fetch(CLOUDFLARE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'debugSessions' }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json() as any;
    return {
      success: true,
      sessions: data.sessions,
      sessionIds: data.sessionIds,
      totalLaunches: data.totalLaunches,
      totalReuses: data.totalReuses,
      totalDisconnects: data.totalDisconnects,
      uptimeSeconds: data.uptimeSeconds,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 关闭 Worker 端的所有浏览器实例，释放 Cloudflare 并发配额
 *
 * 注意：这会关闭浏览器实例，不是清理 session。
 * Session 应该尽量复用（通过 puppeteer.connect() 连接到现有 session）。
 * 只有当残留的浏览器实例占用配额导致 429 错误时才需要调用此操作。
 *
 * Cloudflare 限制：
 * - 每分钟最多创建 3 个新浏览器实例
 * - 每个账号最多并发 3 个浏览器实例
 *
 * 通过 browser.close() 真正关闭实例，释放配额
 */
export async function closeBrowserInstances(): Promise<{
  success: boolean;
  closed?: number;
  remaining?: number;
  errors?: string[];
  error?: string;
}> {
  if (!CLOUDFLARE_WORKER_URL) {
    logger.warn('⚠️ CLOUDFLARE_WORKER_URL not set, skipping browser instance close');
    return { success: false, error: 'CLOUDFLARE_WORKER_URL not set' };
  }

  logger.info('🔌 Closing existing Cloudflare browser instances to release quota...');

  try {
    const response = await fetch(CLOUDFLARE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'closeBrowserInstances' }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.error(`❌ Failed to close browser instances: HTTP ${response.status}: ${errorText}`);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json() as any;

    if (data.closed > 0) {
      logger.info(`✅ Closed ${data.closed} browser instances, ${data.remaining} remaining`);
    } else {
      logger.info(`✅ No browser instances to close (${data.remaining} remaining)`);
    }

    if (data.errors && data.errors.length > 0) {
      logger.warn(`⚠️ Some close errors: ${data.errors.join(', ')}`);
    }

    return {
      success: true,
      closed: data.closed,
      remaining: data.remaining,
      errors: data.errors,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Failed to close browser instances: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * 检查并报告当前 session 状态
 * 在程序启动时调用，用于诊断
 */
export async function checkAndReportSessionStatus(): Promise<void> {
  if (!CLOUDFLARE_WORKER_URL) {
    logger.warn('⚠️ CLOUDFLARE_WORKER_URL not set, skipping session status check');
    return;
  }

  logger.info('🔍 Checking Cloudflare browser session status...');

  const stats = await getWorkerSessionStats();

  if (!stats.success) {
    logger.warn(`⚠️ Failed to get session stats: ${stats.error}`);
    return;
  }

  logger.info(`📊 Cloudflare Browser Session Status:`);
  logger.info(`   • Current sessions: ${stats.sessions} (Cloudflare limit: 3 concurrent)`);
  if (stats.sessionIds && stats.sessionIds.length > 0) {
    logger.info(`   • Session IDs: ${stats.sessionIds.join(', ')}`);
  }
  logger.info(`   • Worker uptime: ${stats.uptimeSeconds}s`);
  logger.info(`   • Total launches: ${stats.totalLaunches}`);
  logger.info(`   • Total reuses: ${stats.totalReuses}`);
  logger.info(`   • Total disconnects: ${stats.totalDisconnects}`);

  // 如果有 3 个或更多 session，发出警告
  if (stats.sessions && stats.sessions >= 3) {
    logger.warn(`⚠️ WARNING: ${stats.sessions} sessions exist, which is at or above Cloudflare's limit of 3 concurrent browsers!`);
    logger.warn(`   Consider running cleanup before starting new requests.`);
  }
}

async function scheduleDynamicSlot(): Promise<void> {
  // serialize calls to respect per-minute create-browser limits
  const prev = dynamicQueue;
  let release!: () => void;
  dynamicQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prev;
  try {
    const now = Date.now();
    const waitMs = Math.max(0, lastDynamicStartedAt + WORKER_DYNAMIC_MIN_INTERVAL_MS - now);
    if (waitMs > 0) {
      logger.info(`⏳ scheduleDynamicSlot: waiting ${Math.round(waitMs / 1000)}s before next Worker request (minInterval=${WORKER_DYNAMIC_MIN_INTERVAL_MS}ms)`);
      await sleep(waitMs);
    }
    lastDynamicStartedAt = Date.now();
    totalWorkerRequests++;
    const uptimeMs = Date.now() - appStartTime;
    logger.info(`🚀 scheduleDynamicSlot: starting Worker request #${totalWorkerRequests} (uptime=${Math.round(uptimeMs / 1000)}s, 429s=${totalWorker429s}, errors=${totalWorkerErrors})`);
  } finally {
    release();
  }
}

// REST API path removed: campaign info requires clicking dialogs; use Workers + Puppeteer instead.

/**
 * 使用 Cloudflare Workers + Puppeteer 提取 Campaign info
 */
export async function extractCampaignInfoWithWorker(key: string): Promise<MeritCampaignInfo[]> {
  if (!CLOUDFLARE_WORKER_URL) {
    logger.warn('⚠️ CLOUDFLARE_WORKER_URL not set, skipping Cloudflare Worker for campaign info');
    return [];
  }

  try {
    const response = await fetch(CLOUDFLARE_WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'extractCampaignInfo',
        key,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Cloudflare Worker HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json() as { success: boolean; result?: MeritCampaignInfo[]; error?: string };

    if (!data.success) {
      logger.warn(`⚠️ Cloudflare Worker failed for ${key}:`, data.error || 'Unknown error');
      return [];
    }

    return Array.isArray(data.result) ? data.result : [];
  } catch (error) {
    logger.warn(`⚠️ Cloudflare campaign info Worker failed for ${key}:`, error);
    return [];
  }
}

export interface MeritDynamicInfo {
  campaignInfo: MeritCampaignInfo[];
  selfAuthDescription: string | null;
  source: 'worker' | 'puppeteer';
}

/**
 * 使用 Cloudflare Workers + Puppeteer 一次性提取动态信息：
 * - Campaign info（需要点击 dialog）
 * - Self authentication 描述（可能需要 JS 渲染）
 */
export async function extractMeritDynamicInfoWithWorker(key: string): Promise<MeritDynamicInfo | null> {
  if (!CLOUDFLARE_WORKER_URL) {
    logger.warn('⚠️ CLOUDFLARE_WORKER_URL not set, skipping Cloudflare Worker for dynamic merit info');
    return null;
  }

  try {
    if (Date.now() < workerDisabledUntil) {
      const waitMs = workerDisabledUntil - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }

    for (let attempt = 0; attempt <= WORKER_DYNAMIC_MAX_RETRIES; attempt++) {
      await scheduleDynamicSlot();

      // CRITICAL: Acquire semaphore to prevent multiple Worker instances from creating browsers
      // This ensures only 1 request at a time, preventing multiple Worker instances
      // from trying to create browser instances simultaneously (which causes 429 errors)
      const release = await workerRequestSemaphore.acquire();
      let released = false;
      
      const safeRelease = () => {
        if (!released) {
          released = true;
          release();
        }
      };
      
      try {
        const response = await fetch(CLOUDFLARE_WORKER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'extractDynamicInfo',
            key,
          }),
        });

        if (response.status === 429) {
          totalWorker429s++;
          const retryAfter = Number(response.headers.get('Retry-After') ?? '0');
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : WORKER_DYNAMIC_MIN_INTERVAL_MS;
          const errorText = await response.text().catch(() => '');

          // 获取当前 session 状态以帮助诊断
          const sessionStats = await getWorkerSessionStats();

          logger.warn(`🚨 Cloudflare Worker 429 RATE LIMITED for ${key}:`);
          logger.warn(`   • Error: ${errorText ? trimErrorSnippet(errorText) : 'No error text'}`);
          logger.warn(`   • Retry-After header: ${retryAfter}s`);
          logger.warn(`   • Will wait: ${Math.round(waitMs / 1000)}s`);
          logger.warn(`   • Total 429s so far: ${totalWorker429s}`);
          logger.warn(`   • Current sessions: ${sessionStats.sessions ?? 'unknown'} (limit: 3)`);
          if (sessionStats.sessionIds && sessionStats.sessionIds.length > 0) {
            logger.warn(`   • Session IDs: ${sessionStats.sessionIds.join(', ')}`);
          }
          logger.warn(`   • Worker stats: launches=${sessionStats.totalLaunches}, reuses=${sessionStats.totalReuses}`);

          workerDisabledUntil = Date.now() + Math.max(waitMs, WORKER_DYNAMIC_CIRCUIT_BREAKER_MS);
          safeRelease(); // Release semaphore before waiting/returning
          if (WORKER_DYNAMIC_FAIL_FAST) {
            return null;
          }
          await sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');

          // Worker may respond 500 with embedded 429 message for Browser Rendering binding limits.
          const looksRateLimited =
            response.status === 500 &&
            /rate limit exceeded|code:\s*429|too many requests/i.test(errorText);

          const looksTransientPuppeteer =
            response.status === 500 &&
            /detached Frame|Execution context was destroyed|Target closed|Navigation failed|Protocol error/i.test(errorText);

          if (looksRateLimited && attempt < WORKER_DYNAMIC_MAX_RETRIES) {
            totalWorker429s++;

            // 获取当前 session 状态以帮助诊断
            const sessionStats = await getWorkerSessionStats();

            logger.warn(`🚨 Cloudflare Worker 500 (embedded rate limit) for ${key}:`);
            logger.warn(`   • Error: ${trimErrorSnippet(errorText)}`);
            logger.warn(`   • Total 429s so far: ${totalWorker429s}`);
            logger.warn(`   • Current sessions: ${sessionStats.sessions ?? 'unknown'} (limit: 3)`);
            if (sessionStats.sessionIds && sessionStats.sessionIds.length > 0) {
              logger.warn(`   • Session IDs: ${sessionStats.sessionIds.join(', ')}`);
            }

            const backoffMs = Math.min(120000, WORKER_DYNAMIC_MIN_INTERVAL_MS * Math.pow(2, attempt));
            logger.warn(`   • Will wait: ${Math.round(backoffMs / 1000)}s (exponential backoff)`);
            workerDisabledUntil = Date.now() + Math.max(backoffMs, WORKER_DYNAMIC_CIRCUIT_BREAKER_MS);
            safeRelease(); // Release semaphore before waiting
            if (WORKER_DYNAMIC_FAIL_FAST) {
              return null;
            }
            await sleep(backoffMs);
            continue;
          }

          if (looksTransientPuppeteer && attempt < WORKER_DYNAMIC_MAX_RETRIES) {
            const backoffMs = Math.min(30000, 1000 * Math.pow(2, attempt));
            logger.warn(`⚠️ Cloudflare Worker transient puppeteer error for ${key}, retrying in ${backoffMs}ms`);
            safeRelease(); // Release semaphore before waiting
            await sleep(backoffMs);
            continue;
          }

          safeRelease(); // Release semaphore before throwing
          throw new Error(`Cloudflare Worker HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json() as {
          success: boolean;
          result?: MeritDynamicInfo;
          error?: string;
        };

        if (!data.success) {
          safeRelease(); // Release semaphore before returning
          logger.warn(`⚠️ Cloudflare Worker failed for ${key}:`, data.error || 'Unknown error');
          return null;
        }

        if (!data.result) {
          safeRelease(); // Release semaphore before returning
          return null;
        }
        
        const campaignInfo = Array.isArray(data.result.campaignInfo) ? data.result.campaignInfo : [];
        const selfAuthDescription = data.result.selfAuthDescription ?? null;

        safeRelease(); // Release semaphore on success
        return { campaignInfo, selfAuthDescription, source: 'worker' };
      } finally {
        // Safety net: ensure semaphore is always released
        safeRelease();
      }
    }

    return null;
  } catch (error) {
    logger.warn(`⚠️ Cloudflare dynamic merit info Worker failed for ${key}:`, error);
    return null;
  }
}

/**
 * 使用 Cloudflare Workers + Puppeteer 提取 Self authentication 描述
 */
export async function extractSelfAuthenticationDescriptionWithCloudflare(key: string): Promise<string | null> {
  if (!CLOUDFLARE_WORKER_URL) {
    logger.warn('⚠️ CLOUDFLARE_WORKER_URL not set, skipping Cloudflare Worker');
    return null;
  }

  try {
    const response = await fetch(CLOUDFLARE_WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'extractSelfAuth',
        key,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Cloudflare Worker HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json() as { success: boolean; result?: string | null; error?: string };

    if (!data.success) {
      logger.warn(`⚠️ Cloudflare Worker failed for ${key}:`, data.error || 'Unknown error');
      return null;
    }

    return data.result ?? null;
  } catch (error) {
    logger.warn(`⚠️ Cloudflare self-auth extraction failed for ${key}:`, error);
    return null;
  }
}

// REST API path removed for self-auth; Workers + local Puppeteer handle it.
