import { Router, type Request, type Response } from 'express';
import { getOidcClient, isAuthEnabled, getBaseUrl, generators } from './oidc-client';

const router = Router();

// GET /auth/login — initiate OIDC authorization code flow with PKCE
router.get('/login', (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    return res.status(503).json({ error: 'Authentication is not enabled' });
  }

  const client = getOidcClient();
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);

  req.session.oidcState = state;
  req.session.oidcNonce = nonce;
  req.session.oidcCodeVerifier = codeVerifier;
  req.session.returnTo = (req.query.returnTo as string) || '/';

  const authUrl = client.authorizationUrl({
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: `${getBaseUrl()}/auth/callback`,
  });

  res.redirect(authUrl);
});

// GET /auth/callback — exchange authorization code for tokens
router.get('/callback', async (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    return res.status(503).json({ error: 'Authentication is not enabled' });
  }

  try {
    const client = getOidcClient();
    const params = client.callbackParams(req);

    const tokenSet = await client.callback(`${getBaseUrl()}/auth/callback`, params, {
      state: req.session.oidcState,
      nonce: req.session.oidcNonce,
      code_verifier: req.session.oidcCodeVerifier,
    });

    // Store token set in session
    req.session.tokenSet = {
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      id_token: tokenSet.id_token,
      expires_at: tokenSet.expires_at,
      token_type: tokenSet.token_type,
    };

    // Extract user claims from ID token
    const claims = tokenSet.claims();
    const realmAccess = (claims as Record<string, unknown>).realm_access as
      | { roles?: string[] }
      | undefined;

    req.session.user = {
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      preferred_username: claims.preferred_username,
      realm_roles: realmAccess?.roles,
    };

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

  const client = getOidcClient();
  const idTokenHint = req.session.tokenSet?.id_token;

  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] Session destroy error:', err);
    }

    let logoutUrl: string;
    try {
      logoutUrl = client.endSessionUrl({
        id_token_hint: idTokenHint,
        post_logout_redirect_uri: getBaseUrl(),
      });
    } catch {
      // If endSessionUrl fails (e.g., no end_session_endpoint), redirect to base
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
    // When auth is disabled, treat everyone as authenticated
    return res.json({
      authenticated: true,
      user: { sub: 'dev', email: 'dev@localhost', name: 'Developer', preferred_username: 'dev' },
    });
  }

  if (req.session.user && req.session.tokenSet) {
    return res.json({ authenticated: true, user: req.session.user });
  }

  return res.status(401).json({ authenticated: false, user: null });
});

export const authMeRoute = meRouter;
