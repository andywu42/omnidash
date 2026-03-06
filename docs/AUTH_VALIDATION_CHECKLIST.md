# Auth Validation Checklist

Validation requirements for omnidash Keycloak/OIDC authentication.

## Automated Checks (via `npm run test:auth-smoke`)

| # | Check | Expected Result | Skip Condition |
|---|-------|----------------|----------------|
| 1 | Keycloak OIDC discovery | `GET {KEYCLOAK_ISSUER}/.well-known/openid-configuration` returns JSON with `authorization_endpoint` | `KEYCLOAK_ISSUER` not set or unreachable |
| 2 | Service health includes Keycloak | `/api/health` response contains a `Keycloak` entry | omnidash not running |
| 3 | Auth-disabled contract | `/api/auth/me` returns `{"authEnabled": false}` when `KEYCLOAK_ISSUER` unset | omnidash not running |
| 4 | Cookie audit (dev/http) | Session cookie has `HttpOnly` flag | No session cookie set |
| 5 | Cookie audit (prod/https) | Cookie has `Secure; HttpOnly; SameSite=Lax` | Not in production |

Run: `bash scripts/auth-smoke-test.sh [BASE_URL]`

## Manual Validation

These require a running Keycloak instance with a configured realm and client.

### Login Flow

- [ ] `GET /auth/login` redirects to Keycloak authorization URL
- [ ] Authorization URL includes `code_challenge` (PKCE S256)
- [ ] After Keycloak login, callback redirects to `returnTo` path
- [ ] Session contains `user` and `tokenSet` after successful login
- [ ] `GET /api/auth/me` returns `{authenticated: true, user: {...}}` after login

### Token Refresh

- [ ] Access token is refreshed when expiring within 60 seconds
- [ ] Refresh failure destroys session and returns 401
- [ ] New refresh token is stored if rotated by Keycloak

### Logout

- [ ] `POST /auth/logout` destroys the session
- [ ] Response includes Keycloak `logoutUrl` for end-session
- [ ] After logout, `/api/auth/me` returns 401

### Security

- [ ] Session cookie uses `omnidash.sid` name
- [ ] Cookie `maxAge` is 24 hours
- [ ] In production: `Secure`, `HttpOnly`, `SameSite=Lax` flags all present
- [ ] `trust proxy` is set in production for correct `Secure` cookie behavior
- [ ] `SESSION_SECRET` is required in production (server exits if missing)
- [ ] `KEYCLOAK_CLIENT_SECRET` is never exposed to the client

### Graceful Degradation

- [ ] Server starts successfully without `KEYCLOAK_ISSUER`
- [ ] All `/api/*` routes remain accessible when auth is disabled
- [ ] `/api/health` shows `Keycloak: {configured: false}` when issuer unset
- [ ] `/api/health` shows `Keycloak: {configured: true, status: "up"}` when issuer is reachable
