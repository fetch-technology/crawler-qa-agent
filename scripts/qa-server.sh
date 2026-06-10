#!/usr/bin/env bash
# Launch the QA dashboard server under a CPU ceiling so a co-located service on
# the same Mac mini keeps headroom. Used by ecosystem.config.cjs (pm2).
#
# Mechanism: cpulimit caps TOTAL CPU% of the process tree. On macOS/Apple
# Silicon there is NO way to pin a process to an exact set of cores (no
# taskset/affinity), so a percentage ceiling is the closest equivalent:
#   N cores  ≈  N * 100 %   (e.g. 7 cores → 700%).
# `-i` (include children) makes the limit cover Chromium's separate renderer /
# GPU processes too — without it they'd escape the cap.
#
# Config (env, with defaults):
#   QA_CPU_CORES   cores' worth of CPU to allow   (default 7)
#   QA_CPU_LIMIT   set to "0" to disable the cap entirely (run uncapped)
#
# SAFETY: if cpulimit isn't installed, we log a hint and run UNCAPPED rather
# than failing to boot — the server must always come up. Install the limiter
# with:  brew install cpulimit
set -euo pipefail

cd "$(dirname "$0")/.."
TSX="./node_modules/.bin/tsx"
ENTRY="src/server/index.ts"

CORES="${QA_CPU_CORES:-7}"
PCT=$(( CORES * 100 ))

if [ "${QA_CPU_LIMIT:-1}" = "0" ]; then
  echo "[qa-server] QA_CPU_LIMIT=0 → running UNCAPPED" >&2
  exec "$TSX" "$ENTRY"
fi

if command -v cpulimit >/dev/null 2>&1; then
  echo "[qa-server] CPU ceiling: ${PCT}% (~${CORES} cores) via cpulimit -i" >&2
  exec cpulimit -l "$PCT" -i -- "$TSX" "$ENTRY"
fi

echo "[qa-server] WARNING: cpulimit not found → running UNCAPPED (other services share CPU freely)." >&2
echo "[qa-server]          Install it to enforce the ~${CORES}-core cap:  brew install cpulimit" >&2
exec "$TSX" "$ENTRY"
