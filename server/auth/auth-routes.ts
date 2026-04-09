import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import * as client from 'openid-client';
import { getOidcConfig, isAuthEnabled, getBaseUrl } from './oidc-client';

// Rate limiter for auth endpoints (15 requests per 60s window per IP)
const authRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication requests, please try again later' },
});

const router = Router();

// GET /auth/login — initiate OIDC authorization code flow with PKCE
router.get('/login', authRateLimiter, async (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    return res.status(503).json({ error: 'Authentication is not enabled' });
  }

  const config = getOidcConfig();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  // Regenerate session to prevent session fixation attacks
  const returnTo = (req.query.returnTo as string) || '/';
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  req.session.oidcState = state;
  req.session.oidcNonce = nonce;
  req.session.oidcCodeVerifier = codeVerifier;
  req.session.returnTo = returnTo;

  const authUrl = client.buildAuthorizationUrl(config, {
    scope: 'openid profile email offline_access',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: `${getBaseUrl()}/auth/callback`,
  });

  res.redirect(authUrl.href);
});

// GET /auth/callback — exchange authorization code for tokens
router.get('/callback', authRateLimiter, async (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    return res.status(503).json({ error: 'Authentication is not enabled' });
  }

  try {
    const config = getOidcConfig();
    const currentUrl = new URL(`${getBaseUrl()}${req.originalUrl}`);

    const tokenResponse = await client.authorizationCodeGrant(config, currentUrl, {
      expectedState: req.session.oidcState,
      expectedNonce: req.session.oidcNonce,
      pkceCodeVerifier: req.session.oidcCodeVerifier,
    });

    // Store token set in session
    req.session.tokenSet = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      id_token: tokenResponse.id_token,
      expires_at: tokenResponse.expires_in
        ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
        : undefined,
      token_type: tokenResponse.token_type,
    };

    // Extract user claims from ID token
    const claims = tokenResponse.claims();
    if (claims) {
      const realmAccess = (claims as Record<string, unknown>).realm_access as
        | { roles?: string[] }
        | undefined;

      req.session.user = {
        sub: claims.sub,
        email: (claims as Record<string, unknown>).email as string | undefined,
        name: (claims as Record<string, unknown>).name as string | undefined,
        preferred_username: (claims as Record<string, unknown>).preferred_username as
          | string
          | undefined,
        realm_roles: realmAccess?.roles,
      };
    }

    // Clean up OIDC flow state
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.oidcCodeVerifier;

    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;

    res.redirect(returnTo);
  } catch (error) {
    console.error('[auth] Callback error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// POST /auth/logout — destroy session and return Keycloak logout URL
router.post('/logout', (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    return res.status(503).json({ error: 'Authentication is not enabled' });
  }

  const config = getOidcConfig();
  const idTokenHint = req.session.tokenSet?.id_token;

  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] Session destroy error:', err);
    }

    let logoutUrl: string;
    try {
      const params: Record<string, string> = {};
      if (idTokenHint) params.id_token_hint = idTokenHint;
      params.post_logout_redirect_uri = getBaseUrl();
      logoutUrl = client.buildEndSessionUrl(config, params).href;
    } catch {
      // If buildEndSessionUrl fails (e.g., no end_session_endpoint), redirect to base
      logoutUrl = getBaseUrl();
    }

    res.json({ logoutUrl });
  });
});

export const authRoutes = router;

// Separate router for /api/auth/me — mounted at /api/auth
const meRouter = Router();

meRouter.get('/me', (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    // Auth-disabled contract: signal that auth is not configured
    return res.json({ authEnabled: false, authenticated: true });
  }

  if (req.session.user && req.session.tokenSet) {
    return res.json({ authenticated: true, user: req.session.user });
  }

  return res.status(401).json({ authenticated: false, user: null });
});

export const authMeRoute = meRouter;
