import cors from 'cors';

// CORS 配置，允许前端访问
// 开发环境：允许所有来源
// 生产环境：可通过 FRONTEND_URL 环境变量限制特定域名（多个域名用逗号分隔）
// 生产环境也允许通过 ALLOWED_DEV_ORIGINS 环境变量添加开发/测试环境（如 Codex 在线仿真环境）

// 常见的开发/测试环境域名模式（用于识别 Codex、WARP 等在线开发环境）
const DEV_ENV_PATTERNS = [
  'codex.warp.dev',
  'warp.dev',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
];

const corsOptions = process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL
  ? {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // 允许没有 origin 的请求（如移动应用、Postman 等）
        if (!origin) return callback(null, true);
        
        // 检查是否在 FRONTEND_URL 白名单中
        const allowedOrigins = process.env.FRONTEND_URL!.split(',').map(url => url.trim());
        if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
          return callback(null, true);
        }
        
        // 检查是否在额外的开发环境白名单中（ALLOWED_DEV_ORIGINS）
        if (process.env.ALLOWED_DEV_ORIGINS) {
          const devOrigins = process.env.ALLOWED_DEV_ORIGINS.split(',').map(url => url.trim());
          if (devOrigins.some(allowed => origin.startsWith(allowed))) {
            return callback(null, true);
          }
        }
        
        // 检查是否是常见的开发/测试环境
        if (DEV_ENV_PATTERNS.some(pattern => origin.includes(pattern))) {
          return callback(null, true);
        }
        
        // 都不匹配，拒绝请求
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }
  : {
      origin: true, // 开发环境允许所有来源
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    };

export const corsMiddleware = cors(corsOptions);
