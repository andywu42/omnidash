import type { Request, Response, NextFunction } from 'express';
import { isAuthEnabled, getOidcClient } from './oidc-client';

/**
 * Middleware: refresh access token if expiring within 60 seconds.
 * Scoped to /api routes and WS handshake only.
 * On refresh failure: destroys session and responds 401 directly (does not call next()).
 */
export function refreshTokenIfNeeded(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  const tokenSet = req.session?.tokenSet;
  if (!tokenSet?.refresh_token || !tokenSet.expires_at) {
    next();
    return;
  }

  const expiresAt = tokenSet.expires_at;
  const now = Math.floor(Date.now() / 1000);

  if (expiresAt - now > 60) {
    // Token still valid for more than 60s
    next();
    return;
  }

  // Token expiring soon — refresh
  const client = getOidcClient();
  client
    .refresh(tokenSet.refresh_token)
    .then((newTokenSet) => {
      req.session.tokenSet = {
        access_token: newTokenSet.access_token,
        refresh_token: newTokenSet.refresh_token || tokenSet.refresh_token,
        id_token: newTokenSet.id_token || tokenSet.id_token,
        expires_at: newTokenSet.expires_at,
        token_type: newTokenSet.token_type,
      };
      next();
    })
    .catch((error) => {
      console.error('[auth] Token refresh failed:', error);
      req.session.destroy(() => {
        res.status(401).json({ error: 'Session expired', authenticated: false });
      });
    });
}

/**
 * Middleware: require authenticated session. Returns 401 if no session.
 * Skipped when auth is disabled.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  if (req.session?.user && req.session?.tokenSet) {
    next();
    return;
  }

  res.status(401).json({ error: 'Authentication required', authenticated: false });
}
