import cors from 'cors';
import { normalizeOrigin, isOriginAllowed, parseSeoOrigins } from './corsOrigin.js';

const isRestrictedEnv = ['production', 'staging'].includes(process.env.NODE_ENV || '');
const corsOptions = isRestrictedEnv && process.env.FRONTEND_URL
  ? {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) return callback(null, true);

        const allowedOrigins = process.env.FRONTEND_URL!.split(',').map(url => url.trim());
        if (isOriginAllowed(origin, allowedOrigins)) {
          return callback(null, true);
        }

        if (process.env.ALLOWED_DEV_ORIGINS) {
          const devOrigins = process.env.ALLOWED_DEV_ORIGINS.split(',').map(url => url.trim());
          if (isOriginAllowed(origin, devOrigins)) {
            return callback(null, true);
          }
        }

        const seoOrigins = parseSeoOrigins();
        if (seoOrigins.length > 0 && isOriginAllowed(origin, seoOrigins)) {
          return callback(null, true);
        }

        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
    }
  : {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        callback(null, true);
      },
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
    };

export const corsMiddleware = cors(corsOptions);
