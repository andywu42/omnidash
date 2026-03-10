#!/usr/bin/env bash
# Source the platform env file before starting any Node.js process.
# This aligns omnidash local startup with the Python-repo env model:
# both use ~/.omnibase/.env as the platform config source of truth.
# The mechanism differs (explicit source vs. shell-session inheritance)
# but the source is identical.
#
# Cloud: ~/.omnibase/.env does not exist in containers.
# K8s env vars injected by the Infisical operator are already present —
# this script is a no-op in that context.

OMNIBASE_ENV="${HOME}/.omnibase/.env"
if [ -f "${OMNIBASE_ENV}" ]; then
    # shellcheck source=/dev/null
    set -a
    source "${OMNIBASE_ENV}"
    set +a
fi

exec "$@"
