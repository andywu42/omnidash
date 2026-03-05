import 'express-session';

declare module 'express-session' {
  interface SessionData {
    oidcState?: string;
    oidcNonce?: string;
    oidcCodeVerifier?: string;
    returnTo?: string;
    tokenSet?: {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_at?: number;
      token_type?: string;
    };
    user?: {
      sub: string;
      email?: string;
      name?: string;
      preferred_username?: string;
      realm_roles?: string[];
    };
  }
}
