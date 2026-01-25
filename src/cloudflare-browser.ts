import fetch from 'node-fetch';
import { logger } from './logger.js';
import { cloudflareWorkerConfig } from './config.js';
import type { MeritCampaignInfo } from './merit-api.js';

/**
 * 带超时的 Promise 包装函数
 * 如果原始 Promise 在指定时间内没有完成，会 reject 一个 TimeoutError
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${errorMessage} (timeout after ${timeoutMs}ms)`));
      }, timeoutMs);
    }),
  ]);
}

// Cloudflare Worker URL (set via environment variable)
// Example: https://aave-browser-rendering.your-subdomain.workers.dev
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建一个 Promise，当 Worker 被禁用时 resolve
 * 用于中断等待，完全事件驱动，无需定期检查
 */
function createWorkerDisabledPromise(): Promise<void> {
  return new Promise((resolve) => {
    // 如果已经被禁用，立即 resolve
    if (Date.now() < workerDisabledUntil) {
      resolve();
      return;
    }
    // 否则保存 resolver 到数组，等待 workerDisabledUntil 被设置时调用所有 resolver
    workerDisabledResolvers.push(resolve);
  });
}

/**
 * 触发所有等待中的 Promise，立即中断等待
 */
function triggerWorkerDisabledResolvers(): void {
  const resolvers = workerDisabledResolvers.splice(0); // 清空数组并获取所有 resolver
  resolvers.forEach(resolve => resolve());
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
// Promise resolvers 数组：当 workerDisabledUntil 被设置时，resolve 所有等待中的 Promise
const workerDisabledResolvers: Array<() => void> = [];
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
logger.info('🔒 Created Cloudflare Worker request semaphore with concurrency=1 (controls HTTP requests to Worker)');

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
    // 如果 Worker 已被禁用，不需要等待速率限制，直接返回（调用方会检查并 fallback）
    if (Date.now() < workerDisabledUntil) {
      const waitMs = workerDisabledUntil - Date.now();
      logger.info(`⏸️ scheduleDynamicSlot: Worker disabled, skipping rate limit wait (${Math.round(waitMs / 1000)}s remaining until re-enable)`);
      return;
    }
    
    const now = Date.now();
    const waitMs = Math.max(0, lastDynamicStartedAt + WORKER_DYNAMIC_MIN_INTERVAL_MS - now);
    if (waitMs > 0) {
      logger.info(`⏳ scheduleDynamicSlot: waiting ${Math.round(waitMs / 1000)}s before next Worker request (minInterval=${WORKER_DYNAMIC_MIN_INTERVAL_MS}ms)`);
      // 使用 Promise.race 来中断等待：如果 Worker 被禁用，立即中断
      // 无需定期检查，完全事件驱动
      const waitPromise = sleep(waitMs);
      const disabledPromise = createWorkerDisabledPromise();
      
      await Promise.race([waitPromise, disabledPromise]);
      
      // 检查是否被禁用
      if (Date.now() < workerDisabledUntil) {
        const remaining = workerDisabledUntil - Date.now();
        logger.info(`⏸️ scheduleDynamicSlot: Worker disabled, skipping request (${Math.round(remaining / 1000)}s remaining until re-enable)`);
        return;
      }
    }
    lastDynamicStartedAt = Date.now();
    totalWorkerRequests++;
    const uptimeMs = Date.now() - appStartTime;
    logger.info(`🚀 scheduleDynamicSlot: starting Worker request #${totalWorkerRequests} (uptime=${Math.round(uptimeMs / 1000)}s, 429s=${totalWorker429s}累计, errors=${totalWorkerErrors})`);
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
 * - Self Authentication 描述（可能需要 JS 渲染）
 * 
 * 注意：此函数有超时保护，如果 Worker 响应时间超过配置的超时时间，会抛出错误
 * 调用方应该捕获错误并 fallback 到 puppeteer
 */
export async function extractMeritDynamicInfoWithWorker(key: string): Promise<MeritDynamicInfo | null> {
  if (!CLOUDFLARE_WORKER_URL) {
    logger.warn('⚠️ CLOUDFLARE_WORKER_URL not set, skipping Cloudflare Worker for dynamic merit info');
    return null;
  }

  const timeoutMs = cloudflareWorkerConfig.dynamicTimeoutMs;
  
  // 使用超时包装，防止 Worker 卡住阻塞进程
  return withTimeout(
    extractMeritDynamicInfoWithWorkerInternal(key),
    timeoutMs,
    `Cloudflare Worker request timeout for ${key}`
  );
}

/**
 * Worker 请求的内部实现（不带超时，由外部包装函数添加超时）
 */
async function extractMeritDynamicInfoWithWorkerInternal(key: string): Promise<MeritDynamicInfo | null> {
  // 这个函数只在 CLOUDFLARE_WORKER_URL 存在时被调用，但为了类型安全，再次检查
  if (!CLOUDFLARE_WORKER_URL) {
    return null;
  }

  try {
    // 如果 Worker 因为 429 被禁用，直接返回 null 让调用方 fallback 到 puppeteer
    // 而不是等待，因为等待可能导致超时，而且已经知道 Worker 不可用了
    if (Date.now() < workerDisabledUntil) {
      const waitMs = workerDisabledUntil - Date.now();
      logger.info(`⏸️ Worker disabled until ${new Date(workerDisabledUntil).toISOString()} (${Math.round(waitMs / 1000)}s remaining), returning null for immediate fallback to puppeteer`);
      return null;
    }

    for (let attempt = 0; attempt <= WORKER_DYNAMIC_MAX_RETRIES; attempt++) {
      // 在 scheduleDynamicSlot 之前再次检查，避免在等待速率限制时超时
      if (Date.now() < workerDisabledUntil) {
        const waitMs = workerDisabledUntil - Date.now();
        logger.info(`⏸️ Worker disabled during retry attempt ${attempt + 1}, returning null for immediate fallback to puppeteer`);
        return null;
      }
      
      await scheduleDynamicSlot();

      // 在 scheduleDynamicSlot 返回后再次检查，因为它可能因为 Worker 被禁用而提前返回
      if (Date.now() < workerDisabledUntil) {
        const waitMs = workerDisabledUntil - Date.now();
        logger.info(`⏸️ Worker disabled after scheduleDynamicSlot, returning null for immediate fallback to puppeteer (${Math.round(waitMs / 1000)}s remaining)`);
        return null;
      }

      // CRITICAL: Acquire semaphore to prevent multiple Worker instances from creating browsers
      // This ensures only 1 request at a time, preventing multiple Worker instances
      // from trying to create browser instances simultaneously (which causes 429 errors)
      logger.debug(`🔒 [Worker Semaphore] Acquiring semaphore for Worker request (key: ${key})`);
      const release = await workerRequestSemaphore.acquire();
      logger.debug(`🔒 [Worker Semaphore] Acquired semaphore for Worker request (key: ${key})`);
      let released = false;
      
      const safeRelease = () => {
        if (!released) {
          released = true;
          release();
        }
      };
      
      try {
        // 在获取 semaphore 后再次检查，防止并发请求在检查后、获取 semaphore 前 Worker 被禁用
        if (Date.now() < workerDisabledUntil) {
          const waitMs = workerDisabledUntil - Date.now();
          logger.info(`⏸️ Worker disabled after acquiring semaphore, returning null for immediate fallback to puppeteer (${Math.round(waitMs / 1000)}s remaining)`);
          safeRelease();
          return null;
        }

        // Type guard: CLOUDFLARE_WORKER_URL is checked at function entry, but TypeScript needs this
        if (!CLOUDFLARE_WORKER_URL) {
          safeRelease();
          return null;
        }

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

          // 先记录 429 错误到 log（在等待之前）
          logger.warn(`🚨 Cloudflare Worker 429 RATE LIMITED for ${key}:`);
          logger.warn(`   • 原始错误消息 (Raw error response): ${errorText ? trimErrorSnippet(errorText) : 'No error text'}`);
          logger.warn(`   • Retry-After header: ${retryAfter}s (实际等待: ${retryAfter > 0 ? `${retryAfter}s` : `${Math.round(waitMs / 1000)}s (使用默认间隔)`})`);
          if (WORKER_DYNAMIC_FAIL_FAST) {
            logger.warn(`   • Fail-fast enabled: 立即返回 null，fallback 到 puppeteer（不等待 ${Math.round(waitMs / 1000)}s）`);
          } else {
            logger.warn(`   • Will wait: ${Math.round(waitMs / 1000)}s before retry`);
          }
          logger.warn(`   • Total 429s so far: ${totalWorker429s} (累计 429 错误次数)`);
          logger.warn(`   • Current sessions: ${sessionStats.sessions ?? 'unknown'} (limit: 3)`);
          if (sessionStats.sessionIds && sessionStats.sessionIds.length > 0) {
            logger.warn(`   • Session IDs: ${sessionStats.sessionIds.join(', ')}`);
          }
          logger.warn(`   • Worker stats: launches=${sessionStats.totalLaunches}, reuses=${sessionStats.totalReuses}`);

          workerDisabledUntil = Date.now() + Math.max(waitMs, WORKER_DYNAMIC_CIRCUIT_BREAKER_MS);
          // 触发所有等待中的 Promise，立即中断等待
          triggerWorkerDisabledResolvers();
          safeRelease(); // Release semaphore before waiting/returning
          if (WORKER_DYNAMIC_FAIL_FAST) {
            return null;
          }
          // 等待重设时间（在记录 log 之后）
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
            logger.warn(`   • Total 429s so far: ${totalWorker429s} (累计 429 错误次数)`);
            logger.warn(`   • Current sessions: ${sessionStats.sessions ?? 'unknown'} (limit: 3)`);
            if (sessionStats.sessionIds && sessionStats.sessionIds.length > 0) {
              logger.warn(`   • Session IDs: ${sessionStats.sessionIds.join(', ')}`);
            }

            const backoffMs = Math.min(120000, WORKER_DYNAMIC_MIN_INTERVAL_MS * Math.pow(2, attempt));
            logger.warn(`   • Will wait: ${Math.round(backoffMs / 1000)}s (exponential backoff)`);
            workerDisabledUntil = Date.now() + Math.max(backoffMs, WORKER_DYNAMIC_CIRCUIT_BREAKER_MS);
            // 触发所有等待中的 Promise，立即中断等待
            triggerWorkerDisabledResolvers();
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
 * 使用 Cloudflare Workers + Puppeteer 提取 Self Authentication 描述
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
