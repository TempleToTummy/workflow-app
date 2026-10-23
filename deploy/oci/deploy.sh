#!/usr/bin/env bash
# Build and (re)start the app from the current checkout. Use it for the first
# deploy and for every update:
#
#   deploy/oci/deploy.sh          # pull the latest code, rebuild, restart
#   deploy/oci/deploy.sh --no-pull
#
# The app is unavailable for the minute or so it takes the new container to
# run its startup checks (schema, upgrades) — deploy outside working hours.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR/../.." && pwd)"
COMPOSE=(docker compose -f "$DIR/compose.yaml")

if [[ ! -f "$DIR/.env" ]]; then
  echo "Missing $DIR/.env — copy .env.example and fill it in first (README.md step 8)." >&2
  exit 1
fi

if [[ "${1:-}" != "--no-pull" ]]; then
  echo "==> Pulling latest code"
  git -C "$REPO_DIR" pull --ff-only
fi

echo "==> Building"
"${COMPOSE[@]}" build app

echo "==> Starting"
"${COMPOSE[@]}" up -d

echo "==> Waiting for the app to report healthy (first start can take a few minutes)"
container="$("${COMPOSE[@]}" ps -q app)"
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo starting)"
  case "$status" in
    healthy)
      echo "Healthy."
      docker image prune -f >/dev/null
      exit 0
      ;;
    unhealthy)
      break
      ;;
  esac
  sleep 5
done

echo "The app didn't become healthy. Recent logs:" >&2
"${COMPOSE[@]}" logs --tail 80 app >&2
exit 1
