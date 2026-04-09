import * as client from 'openid-client';

let oidcConfig: client.Configuration | null = null;
let authEnabled = false;

export function isAuthEnabled(): boolean {
  return authEnabled;
}

export function getBaseUrl(): string {
  const url = process.env.OMNIDASH_BASE_URL;
  if (!url) throw new Error('OMNIDASH_BASE_URL is required');
  return url;
}

export function getOidcConfig(): client.Configuration {
  if (!oidcConfig) {
    throw new Error('OIDC client not initialized. Call initOidcClient() first.');
  }
  return oidcConfig;
}

export async function initOidcClient(): Promise<void> {
  // OMN-5057: Explicit env var override to disable auth for local dev / automated tooling.
  // When OMNIDASH_AUTH_ENABLED=false, auth is unconditionally disabled regardless of
  // KEYCLOAK_ISSUER. This prevents ~/.omnibase/.env Keycloak vars from enabling auth
  // in local development where no Keycloak server is running.
  const authExplicitlyDisabled = process.env.OMNIDASH_AUTH_ENABLED === 'false'; // ONEX_FLAG_EXEMPT: migration
  if (authExplicitlyDisabled) {
    console.log('[oidc] OMNIDASH_AUTH_ENABLED=false -- auth disabled by explicit env override');
    authEnabled = false;
    return;
  }

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
    const config = await client.discovery(
      new URL(issuerUrl),
      clientId,
      { redirect_uris: [`${getBaseUrl()}/auth/callback`] },
      client.ClientSecretPost(clientSecret),
    );

    const serverMeta = config.serverMetadata();
    console.log(`[oidc] Discovered issuer: ${serverMeta.issuer}`);

    oidcConfig = config;
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
