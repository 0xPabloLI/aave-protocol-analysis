import cors from 'cors';

// CORS 配置，允许前端访问
// 开发环境：允许所有来源
// 生产环境：可通过 FRONTEND_URL 环境变量限制特定域名（多个域名用逗号分隔）
const corsOptions = process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL
  ? {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // 允许没有 origin 的请求（如移动应用、Postman 等）
        if (!origin) return callback(null, true);
        
        const allowedOrigins = process.env.FRONTEND_URL!.split(',').map(url => url.trim());
        // 检查是否在允许列表中
        if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
          callback(null, true);
        } else {
          callback(null, false); // 可以根据需要改为 false 来限制来源
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
