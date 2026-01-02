import winston from 'winston';
import { mkdirSync } from 'fs';
import { join } from 'path';

// 确保 logs 目录存在（同步方式，确保在 logger 创建前目录已存在）
try {
  mkdirSync('logs', { recursive: true });
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
  defaultMeta: { service: 'aave-markets-data' },
  transports: [
    // 错误日志文件（只记录 error 级别）
    new winston.transports.File({
      filename: join('logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // 所有日志文件
    new winston.transports.File({
      filename: join('logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // 控制台输出
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

// 如果是开发环境，设置为 debug 级别
if (process.env.NODE_ENV !== 'production') {
  logger.level = 'debug';
}

export default logger;

