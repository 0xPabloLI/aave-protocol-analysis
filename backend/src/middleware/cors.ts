import cors from 'cors';

// CORS 配置，允许前端访问
// 支持多个来源：本地开发、生产环境等
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'];

// 允许所有来源（生产环境建议限制为特定域名）
const corsOptions = process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL
  ? {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // 允许没有 origin 的请求（如移动应用、Postman 等）
        if (!origin) return callback(null, true);
        
        // 检查是否在允许列表中
        if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
          callback(null, true);
        } else {
          // 生产环境：允许所有来源（可以根据需要限制）
          callback(null, true);
        }
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
