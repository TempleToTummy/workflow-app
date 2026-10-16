#!/usr/bin/env bash
# Day-to-day jobs against the running app container. /etc/cron.d/workflow
# (installed by setup-vm.sh) calls the first two daily.
#
#   deploy/oci/ops.sh generate-periods   open new periods and generate work
#   deploy/oci/ops.sh backup             encrypted backup to /srv/workflow/data/backups
#   deploy/oci/ops.sh logs               follow the app's logs
#   deploy/oci/ops.sh status             container status
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$DIR/compose.yaml")

echo "[$(date -u +%FT%TZ)] ops.sh ${1:-}"
case "${1:-}" in
  generate-periods)
    # Called from inside the container so CRON_SECRET never leaves it and the
    # job doesn't depend on DNS or the certificate.
    "${COMPOSE[@]}" exec -T app node -e '
      fetch("http://127.0.0.1:3000/api/cron/generate-periods", {
        method: "POST",
        headers: { authorization: "Bearer " + process.env.CRON_SECRET },
      })
        .then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })
        .catch((e) => { console.error(e); process.exit(1); });
    '
    ;;
  backup)
    "${COMPOSE[@]}" exec -T app npx tsx scripts/backup.ts --files --keep 14
    ;;
  logs)
    "${COMPOSE[@]}" logs -f --tail 100 app
    ;;
  status)
    "${COMPOSE[@]}" ps
    ;;
  *)
    sed -n '2,9p' "$0"
    exit 1
    ;;
esac
