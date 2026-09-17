import "./env.js";
import winston from "winston";
import { mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

// 确保 logs 目录存在
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKEND_DIR = resolve(__dirname, "..");
const LOGS_DIR = resolve(BACKEND_DIR, "logs");

try {
  mkdirSync(LOGS_DIR, { recursive: true });
} catch (error) {
  // 如果目录已存在，忽略错误
}

// 定义日志格式
const SENSITIVE_KEY =
  /^(authorization|apikey|api_key|api-key|token|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie|set-cookie|dsn|sentry[-_]?dsn|sessionid|session[-_]?id)$/i;

/**
 * Pattern scrubbers for secrets that appear *inside* free-text values
 * (log messages, error strings, URLs) rather than as a structured key.
 *
 * Deliberately conservative: each pattern requires a recognisable secret
 * shape so ordinary prose ("the token is required") is left intact.
 * Order matters — header-style redaction runs before the bare `Bearer` rule
 * so a header line is collapsed once instead of twice.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // scheme://user:password@host → scheme://[REDACTED]@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@"],
  // Real header names only — a bare `apikey=` is a query/form param, handled below.
  [/\b(authorization|x-api-key)\s*[:=]\s*[^\s,;'"]+/gi, "$1: [REDACTED]"],
  // Query-string / form secrets (need a leading ? & whitespace boundary).
  [
    /([?&\s])((?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|sig|signature)=)[^&\s"']+/gi,
    "$1$2[REDACTED]",
  ],
  // Bearer <token> (token must look like one — 8+ token chars)
  [/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, "Bearer [REDACTED]"],
  // JWT (three base64url segments)
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[REDACTED]",
  ],
  // provider key prefixes (OpenAI-style, GitHub PATs)
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
];

/**
 * Redact secret-shaped substrings from a free-text value (log_scrubbing gate).
 * Exported pure for testing.
 */
export function scrubSecretsInString(input: string): string {
  // Cheap bail-out: no pattern can match a string this short.
  if (input.length < 12) return input;
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Deep-scrub sensitive keys and secret-shaped string values from log metadata
 * (log_scrubbing gate). Exported pure for testing.
 */
export function scrubSensitiveMeta<T>(meta: T, depth = 0): T {
  if (meta === null || typeof meta !== "object" || depth > 8) return meta;
  if (Array.isArray(meta)) {
    return meta.map((item) =>
      scrubSensitiveMeta(item, depth + 1)
    ) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : typeof value === "string"
        ? scrubSecretsInString(value)
        : scrubSensitiveMeta(value, depth + 1);
  }
  return out as unknown as T;
}

/**
 * Winston format that redacts secrets from a log record.
 *
 * It rewrites `info` **in place** instead of returning a rebuilt object. The
 * record carries the triple-beam symbols (`LEVEL`, `MESSAGE`, `SPLAT`) as
 * symbol keys, and both spread and `Object.entries` only carry string keys —
 * so rebuilding silently drops them. Losing `LEVEL` is not cosmetic:
 * `winston-transport` gates every write on `this.levels[info[LEVEL]]`, so a
 * missing symbol makes `levels[level] >= levels[undefined]` false for *every*
 * transport and the record is discarded with no error at all. (Fixed in
 * AAV-1290 — this was a silent, total log blackout.)
 */
const scrubFormat = winston.format((info) => {
  if (typeof info !== "object" || info === null) return info;
  const record = info as Record<string | symbol, unknown>;

  for (const key of Object.keys(record)) {
    // `level` is a routing key read by the level gates and by colorize —
    // never a secret. `timestamp` is machine-generated.
    if (key === "level" || key === "timestamp") continue;
    const value = record[key];
    if (SENSITIVE_KEY.test(key)) {
      record[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      // Free text (message, URLs, error strings) gets the pattern scrubbers.
      record[key] = scrubSecretsInString(value);
    } else if (value !== null && typeof value === "object") {
      record[key] = scrubSensitiveMeta(value);
    }
  }

  return info;
})();

const logFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  // scrubFormat 必须排在 splat() 之后、渲染之前：`logger.info(msg, meta)` 的第二个
  // 参数要到 splat() 才被并入记录，排在它前面会让这段元数据绕过脱敏。
  scrubFormat,
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}] ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }
    return log;
  })
);

// 控制台格式（带颜色）
// 三条约束缺一不可，否则 Console 通道要么整段静默失效、要么明文泄露：
//   1. scrubFormat 必须留在链上 —— transport 自带 format 会整体覆盖 logger 级
//      format，不加这里就只有文件 transport 被脱敏。
//   2. scrubFormat 必须排在 splat() 之后 —— 否则 `logger.info(msg, meta)` 的元数据
//      绕过脱敏（见 logFormat 处的说明）。
//   3. colorize 必须显式传入颜色表 —— logform 把 level→颜色映射存在 Colorizer 的
//      静态字段上，进程内若从未注册过，`allColors[lookup]` 就是 undefined，
//      `colors[undefined]()` 直接抛 TypeError。显式传 winston.config.npm.colors
//      等价于同时完成「注册 + 使用」，不依赖模块加载顺序。
const consoleFormat = winston.format.combine(
  winston.format.splat(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  scrubFormat,
  winston.format.colorize({ colors: winston.config.npm.colors }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} ${level} ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta, null, 2)}`;
    }
    return log;
  })
);

// 创建 logger 实例
// 在生产环境中，禁用 Console transport 以避免与 PM2 日志重复
// PM2 会捕获 stdout/stderr，而 winston 的 Console transport 也会输出到 stdout
// 为了避免重复，生产环境只使用文件输出，开发环境保留 Console 输出
const transports: winston.transport[] = [
  // 错误日志文件（只记录 error 级别）
  new winston.transports.File({
    filename: join(LOGS_DIR, "error.log"),
    level: "error",
    maxsize: 5242880, // 5MB
    maxFiles: 5, // 保留5个文件，自动轮转
  }),
  // 所有日志文件
  new winston.transports.File({
    filename: join(LOGS_DIR, "combined.log"),
    maxsize: 5242880, // 5MB
    maxFiles: 5, // 保留5个文件，自动轮转
  }),
];

// 只在开发环境启用 Console 输出，避免与 PM2 日志重复
if (process.env.NODE_ENV !== "production") {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

export const logger = winston.createLogger({
  level: "info",
  format: logFormat,
  defaultMeta: { service: "aave-backend" },
  transports,
});

// 如果是开发环境，设置为 debug 级别
if (process.env.NODE_ENV === "development") {
  logger.level = "debug";
}
