import type { Express, RequestHandler } from 'express';
import session from 'express-session';
import { createClient } from 'redis';
import { RedisStore } from 'connect-redis';
import createMemoryStore from 'memorystore';

let sessionMiddleware: RequestHandler | null = null;

export function getSessionMiddleware(): RequestHandler {
  if (!sessionMiddleware) {
    throw new Error('Session not configured. Call configureSession() first.');
  }
  return sessionMiddleware;
}

export async function configureSession(app: Express): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    app.set('trust proxy', 1);
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (isProd && !sessionSecret) {
    console.error('[session] SESSION_SECRET is required in production');
    process.exit(1);
  }

  let store: session.Store | undefined;
  const storeUrl = process.env.SESSION_STORE_URL;

  if (storeUrl) {
    try {
      const redisClient = createClient({ url: storeUrl });
      redisClient.on('error', (err) => {
        console.error('[session] Redis client error:', err);
      });
      await redisClient.connect();
      store = new RedisStore({ client: redisClient });
      console.log('[session] Using Redis session store');
    } catch (error) {
      if (isProd) {
        console.error('[session] Failed to connect to Redis in production:', error);
        process.exit(1);
      }
      console.warn('[session] Redis connection failed, falling back to MemoryStore:', error);
      store = undefined;
    }
  }

  if (!store) {
    const MemoryStore = createMemoryStore(session);
    store = new MemoryStore({ checkPeriod: 86400000 });
    console.log('[session] Using MemoryStore (no SESSION_STORE_URL)');
  }

  sessionMiddleware = session({
    store,
    secret: sessionSecret || 'omnidash-dev-secret-change-me',
    name: 'omnidash.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProd,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  });

  app.use(sessionMiddleware);
}
