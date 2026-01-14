import 'dotenv/config';
import winston from 'winston';
import { mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// 确保 logs 目录存在
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKEND_DIR = resolve(__dirname, '..');
const LOGS_DIR = resolve(BACKEND_DIR, 'logs');

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
export const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  defaultMeta: { service: 'aave-backend' },
  transports: [
    // 错误日志文件（只记录 error 级别）
    new winston.transports.File({
      filename: join(LOGS_DIR, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5, // 保留5个文件，自动轮转
    }),
    // 所有日志文件
    new winston.transports.File({
      filename: join(LOGS_DIR, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5, // 保留5个文件，自动轮转
    }),
    // 控制台输出（生产环境可以移除，因为PM2会捕获）
    new winston.transports.Console({
      format: consoleFormat,
      // 生产环境下，控制台输出会被PM2捕获，可以保留用于调试
    }),
  ],
});

// 如果是开发环境，设置为 debug 级别
if (process.env.NODE_ENV === 'development') {
  logger.level = 'debug';
}

export default logger;
