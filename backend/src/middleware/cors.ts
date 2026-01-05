import cors from 'cors';

// CORS 配置，允许前端访问
export const corsMiddleware = cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173', // Vite 默认端口
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
