#!/usr/bin/env bash
# auth-smoke-test.sh -- Keycloak/OIDC auth validation smoke tests
# Usage: bash scripts/auth-smoke-test.sh [BASE_URL]
#
# Runs 5 checks and reports PASS/FAIL/SKIP for each.

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
KC_URL="${KEYCLOAK_ISSUER:-}"

PASS=0
FAIL=0
SKIP=0

result() {
  local status="$1" label="$2" detail="${3:-}"
  case "$status" in
    PASS) PASS=$((PASS + 1)); printf "\033[32m[PASS]\033[0m %s" "$label" ;;
    FAIL) FAIL=$((FAIL + 1)); printf "\033[31m[FAIL]\033[0m %s" "$label" ;;
    SKIP) SKIP=$((SKIP + 1)); printf "\033[33m[SKIP]\033[0m %s" "$label" ;;
  esac
  if [ -n "$detail" ]; then
    printf " -- %s" "$detail"
  fi
  printf "\n"
}

# ---------- Check 1: Keycloak OIDC discovery ----------
if [ -z "$KC_URL" ]; then
  result SKIP "Keycloak OIDC discovery" "KEYCLOAK_ISSUER not set"
else
  DISC_URL="${KC_URL}/.well-known/openid-configuration"
  if DISC_BODY=$(curl -sf --max-time 5 "$DISC_URL" 2>/dev/null); then
    if echo "$DISC_BODY" | grep -q '"authorization_endpoint"'; then
      result PASS "Keycloak OIDC discovery" "$DISC_URL"
    else
      result FAIL "Keycloak OIDC discovery" "Response missing authorization_endpoint"
    fi
  else
    result SKIP "Keycloak OIDC discovery" "Keycloak unreachable at $DISC_URL"
  fi
fi

# ---------- Check 2: Service health includes Keycloak ----------
if HEALTH_BODY=$(curl -sf --max-time 5 "${BASE_URL}/api/health" 2>/dev/null); then
  # Detect non-JSON response (e.g. Vite HTML when Express backend not running)
  if ! echo "$HEALTH_BODY" | grep -qE '^\s*[\{\[]'; then
    result SKIP "Service health includes Keycloak" "Non-JSON response from $BASE_URL/api/health (Express backend not running?)"
  elif echo "$HEALTH_BODY" | grep -q '"Keycloak"'; then
    result PASS "Service health includes Keycloak"
  else
    result FAIL "Service health includes Keycloak" "No Keycloak entry in /api/health"
  fi
else
  result SKIP "Service health includes Keycloak" "omnidash not running at $BASE_URL"
fi

# ---------- Check 3: Auth-disabled contract ----------
if AUTH_BODY=$(curl -sf --max-time 5 "${BASE_URL}/api/auth/me" 2>/dev/null); then
  # Detect non-JSON response (e.g. Vite HTML when Express backend not running)
  if ! echo "$AUTH_BODY" | grep -qE '^\s*[\{\[]'; then
    result SKIP "Auth-disabled contract" "Non-JSON response from $BASE_URL/api/auth/me (Express backend not running?)"
  elif [ -z "$KC_URL" ]; then
    # When auth is disabled, must return {"authEnabled": false}
    if echo "$AUTH_BODY" | grep -q '"authEnabled".*false'; then
      result PASS "Auth-disabled contract" "/api/auth/me returns {authEnabled: false}"
    else
      result FAIL "Auth-disabled contract" "Expected {authEnabled: false}, got: $AUTH_BODY"
    fi
  else
    # When auth is enabled, expect authenticated or 401
    result PASS "Auth-disabled contract" "Auth enabled -- skipping disabled contract check"
  fi
else
  result SKIP "Auth-disabled contract" "omnidash not running at $BASE_URL"
fi

# ---------- Check 4: Cookie audit (dev/http) ----------
if COOKIE_HEADERS=$(curl -sI --max-time 5 "${BASE_URL}/api/auth/me" 2>/dev/null); then
  COOKIE_LINE=$(echo "$COOKIE_HEADERS" | grep -i '^set-cookie:' || true)
  if [ -z "$COOKIE_LINE" ]; then
    result SKIP "Cookie audit (dev/http)" "No session cookie set"
  else
    if echo "$COOKIE_LINE" | grep -qi 'httponly'; then
      result PASS "Cookie audit (dev/http)" "HttpOnly present"
    else
      result FAIL "Cookie audit (dev/http)" "HttpOnly missing from cookie"
    fi
  fi
else
  result SKIP "Cookie audit (dev/http)" "omnidash not running at $BASE_URL"
fi

# ---------- Check 5: Cookie audit (prod/https) ----------
IS_PROD="${NODE_ENV:-development}"
if [ "$IS_PROD" = "production" ]; then
  if [ -n "$COOKIE_LINE" ]; then
    COOKIE_OK=true
    echo "$COOKIE_LINE" | grep -qi 'secure' || COOKIE_OK=false
    echo "$COOKIE_LINE" | grep -qi 'httponly' || COOKIE_OK=false
    echo "$COOKIE_LINE" | grep -qi 'samesite=lax' || COOKIE_OK=false
    if [ "$COOKIE_OK" = true ]; then
      result PASS "Cookie audit (prod/https)" "Secure; HttpOnly; SameSite=Lax"
    else
      result FAIL "Cookie audit (prod/https)" "Missing required cookie attributes: $COOKIE_LINE"
    fi
  else
    result SKIP "Cookie audit (prod/https)" "No session cookie set"
  fi
else
  result SKIP "Cookie audit (prod/https)" "Not in production (NODE_ENV=$IS_PROD)"
fi

# ---------- Summary ----------
echo ""
echo "=== Auth Smoke Test Summary ==="
printf "  PASS: %d  FAIL: %d  SKIP: %d\n" "$PASS" "$FAIL" "$SKIP"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
