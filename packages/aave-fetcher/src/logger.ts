import winston from 'winston';
import { mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// 确保 logs 目录存在（同步方式，确保在 logger 创建前目录已存在）
// 使用绝对路径，确保无论从哪里运行都写入根目录的 logs/
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const LOGS_DIR = resolve(ROOT_DIR, 'logs');

try {
  mkdirSync(LOGS_DIR, { recursive: true });
} catch (error) {
  // 如果目录已存在，忽略错误
}

// 定义日志格式
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}] ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }
    return log;
  })
);

// 控制台格式（带颜色）
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} ${level} ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta, null, 2)}`;
    }
    return log;
  })
);

// 创建 logger 实例
// 在生产环境中，禁用 Console transport 以避免过度日志输出
// 生产环境只使用文件输出，开发环境保留 Console 输出
const transports: winston.transport[] = [
  // 错误日志文件（只记录 error 级别）
  new winston.transports.File({
    filename: join(LOGS_DIR, 'error.log'),
    level: 'error',
    maxsize: 5242880, // 5MB
    maxFiles: 5,
  }),
  // 所有日志文件
  new winston.transports.File({
    filename: join(LOGS_DIR, 'combined.log'),
    maxsize: 5242880, // 5MB
    maxFiles: 5,
  }),
];

// 只在开发环境启用 Console 输出，避免生产环境过度日志
if (process.env.NODE_ENV !== 'production') {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

export const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  defaultMeta: { service: 'aave-markets-data' },
  transports,
});

