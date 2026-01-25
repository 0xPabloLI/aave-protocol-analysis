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
  '103.151.172.89', // 用户服务器 IP
];

/**
 * 规范化 origin URL，提取协议、主机和端口
 * 返回格式：protocol://host:port（如果端口是默认端口则省略）
 * 重要：默认端口（80 for http, 443 for https）会被移除，确保语义等价性
 */
function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    const protocol = url.protocol; // 包含 ':'，如 "https:"
    const hostname = url.hostname;
    const port = url.port;
    
    // 确定默认端口
    const isHttps = protocol === 'https:';
    const defaultPort = isHttps ? '443' : '80';
    
    // 如果端口是默认端口，移除它以确保语义等价性
    // 例如：https://example.com:443 和 https://example.com 应该被视为相同
    if (port && port !== '' && port !== defaultPort) {
      // 非默认端口：包含端口号
      return `${protocol}//${hostname}:${port}`;
    }
    // 默认端口或没有端口：不包含端口号
    return `${protocol}//${hostname}`;
  } catch {
    return null;
  }
}

/**
 * 检查 origin 是否匹配允许的 origin
 * 使用精确匹配（协议、主机、端口）而不是前缀匹配，防止子域名绕过攻击
 */
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;
  
  return allowedOrigins.some(allowed => {
    const normalizedAllowed = normalizeOrigin(allowed);
    if (!normalizedAllowed) return false;
    
    // 精确匹配协议、主机和端口
    return normalizedOrigin === normalizedAllowed;
  });
}

const corsOptions = process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL
  ? {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // 允许没有 origin 的请求（如移动应用、Postman 等）
        if (!origin) return callback(null, true);
        
        // 检查是否在 FRONTEND_URL 白名单中（使用精确匹配防止子域名绕过）
        const allowedOrigins = process.env.FRONTEND_URL!.split(',').map(url => url.trim());
        if (isOriginAllowed(origin, allowedOrigins)) {
          return callback(null, true);
        }
        
        // 检查是否在额外的开发环境白名单中（ALLOWED_DEV_ORIGINS）
        if (process.env.ALLOWED_DEV_ORIGINS) {
          const devOrigins = process.env.ALLOWED_DEV_ORIGINS.split(',').map(url => url.trim());
          if (isOriginAllowed(origin, devOrigins)) {
            return callback(null, true);
          }
        }
        
        // 生产环境：不检查 DEV_ENV_PATTERNS，严格遵循白名单
        // 都不匹配，拒绝请求
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }
  : {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // 开发环境：允许所有来源，包括开发/测试环境
        if (!origin) return callback(null, true);
        
        // 开发环境允许所有来源，包括 DEV_ENV_PATTERNS
        callback(null, true);
      },
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    };

export const corsMiddleware = cors(corsOptions);
