import { Issuer, type Client, generators } from 'openid-client';

let oidcClient: Client | null = null;
let authEnabled = false;

export { generators };

export function isAuthEnabled(): boolean {
  return authEnabled;
}

export function getBaseUrl(): string {
  return process.env.OMNIDASH_BASE_URL || 'http://localhost:3000';
}

export function getOidcClient(): Client {
  if (!oidcClient) {
    throw new Error('OIDC client not initialized. Call initOidcClient() first.');
  }
  return oidcClient;
}

export async function initOidcClient(): Promise<void> {
  const issuerUrl = process.env.KEYCLOAK_ISSUER;

  if (!issuerUrl) {
    console.log('[oidc] KEYCLOAK_ISSUER not set -- auth disabled (dev mode)');
    authEnabled = false;
    return;
  }

  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // OMN-4960: Graceful degradation instead of process.exit(1).
    // Missing credentials are a config issue, not a crash-worthy failure.
    console.warn(
      '[oidc] KEYCLOAK_ISSUER is set but KEYCLOAK_CLIENT_ID or KEYCLOAK_CLIENT_SECRET is missing — auth disabled'
    );
    authEnabled = false;
    return;
  }

  try {
    const issuer = await Issuer.discover(issuerUrl);
    console.log(`[oidc] Discovered issuer: ${issuer.metadata.issuer}`);

    oidcClient = new issuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [`${getBaseUrl()}/auth/callback`],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    });

    authEnabled = true;
    console.log('[oidc] OIDC client initialized successfully');
  } catch (error) {
    // OMN-4960: Graceful degradation instead of process.exit(1).
    // Unreachable Keycloak should not crash the server — disable auth
    // and let HTTP endpoints work without authentication.
    console.warn('[oidc] Failed to discover OIDC issuer — auth disabled:', error);
    authEnabled = false;
  }
}
