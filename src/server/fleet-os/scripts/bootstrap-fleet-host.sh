#!/usr/bin/env bash
# Bootstrap a Tailscale host as a Fleet OS worker.
# Run on Oakland Mini / SF Mini / Backup Mini / DestrysHP:
#   ./scripts/bootstrap-fleet-host.sh oakland-mini
#   FLEET_OS_URL=http://oakland-mini:3000/api/fleet-os ./scripts/bootstrap-fleet-host.sh sf-mini
set -euo pipefail

MACHINE_ID="${1:-${FLEET_MACHINE_ID:-}}"
if [[ -z "${MACHINE_ID}" ]]; then
  echo "Usage: bootstrap-fleet-host.sh <oakland-mini|sf-mini|backup-mini|destrys-hp>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${FLEET_OS_HOME:-${HERMES_HOME:-$HOME/.hermes}/fleet-os}"
mkdir -p "$HOME_DIR"
ENV_FILE="$HOME_DIR/.env"

upsert_env() {
  local key="$1" value="$2"
  touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # portable in-place replace
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' "$ENV_FILE" >"$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

upsert_env FLEET_MACHINE_ID "$MACHINE_ID"
upsert_env FLEET_OS_HOME "$HOME_DIR"
if [[ -n "${FLEET_OS_URL:-}" ]]; then
  upsert_env FLEET_OS_URL "$FLEET_OS_URL"
elif [[ "$MACHINE_ID" != "oakland-mini" ]]; then
  # Default: workers talk to the Oakland coordination hub HTTP control plane.
  upsert_env FLEET_OS_URL "http://oakland-mini:8787"
fi
if [[ "$MACHINE_ID" == "oakland-mini" ]]; then
  upsert_env FLEET_OS_PORT "${FLEET_OS_PORT:-8787}"
fi
if [[ -n "${FLEET_LEDGER_PATH:-}" ]]; then
  upsert_env FLEET_LEDGER_PATH "$FLEET_LEDGER_PATH"
elif [[ -f "$HOME/Library/Application Support/agentic-os/ledger.sqlite" ]]; then
  upsert_env FLEET_LEDGER_PATH "$HOME/Library/Application Support/agentic-os/ledger.sqlite"
elif [[ -f "$HOME/.agentic-os/ledger.sqlite" ]]; then
  upsert_env FLEET_LEDGER_PATH "$HOME/.agentic-os/ledger.sqlite"
else
  upsert_env FLEET_LEDGER_PATH "$HOME_DIR/agentic-ledger.sqlite"
fi
if [[ -n "${ATTIO_API_KEY:-}" ]]; then
  upsert_env ATTIO_API_KEY "$ATTIO_API_KEY"
fi

# Mark Tailscale mesh only when the host can actually see the mesh.
if [[ "${FLEET_TAILSCALE_MESH:-}" == "1" ]]; then
  upsert_env FLEET_TAILSCALE_MESH 1
elif command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  upsert_env FLEET_TAILSCALE_MESH 1
else
  upsert_env FLEET_TAILSCALE_MESH 0
  echo "WARN: tailscale not verified on this host — readiness will stay blocked." >&2
fi

INTERVAL="${FLEET_ADVERTISE_INTERVAL:-30}"
LOG_FILE="$HOME_DIR/advertise-${MACHINE_ID}.log"
PID_FILE="$HOME_DIR/advertise-${MACHINE_ID}.pid"

cat >"$HOME_DIR/run-advertise.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
exec npx --yes tsx fleet-advertise.ts --machine "\$FLEET_MACHINE_ID" --interval "$INTERVAL"
EOF
chmod +x "$HOME_DIR/run-advertise.sh"

if [[ "$MACHINE_ID" == "oakland-mini" ]]; then
  cat >"$HOME_DIR/run-fleet-server.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
exec npx --yes tsx fleet-server.ts --host 0.0.0.0 --port "\${FLEET_OS_PORT:-8787}" --seed
EOF
  chmod +x "$HOME_DIR/run-fleet-server.sh"
fi

cat >"$HOME_DIR/run-sync-ledger.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
exec npx --yes tsx fleet-sync-ledger.ts
EOF
chmod +x "$HOME_DIR/run-sync-ledger.sh"

# One-shot advertise now
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
npx --yes tsx "$ROOT/fleet-advertise.ts" --machine "$MACHINE_ID" --once | tee -a "$LOG_FILE"
npx --yes tsx "$ROOT/fleet-sync-ledger.ts" | tee -a "$HOME_DIR/sync-ledger.log" || true

if [[ "${FLEET_BOOTSTRAP_DAEMON:-1}" == "1" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    PLIST="$HOME/Library/LaunchAgents/com.byteport.fleet-advertise-${MACHINE_ID}.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.byteport.fleet-advertise-${MACHINE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME_DIR/run-advertise.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
</dict>
</plist>
PLIST
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Loaded LaunchAgent: $PLIST"
  else
    nohup "$HOME_DIR/run-advertise.sh" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo "Started advertise pid $(cat "$PID_FILE") → $LOG_FILE"
  fi
fi

echo
echo "Bootstrapped $MACHINE_ID"
echo "  env:     $ENV_FILE"
  echo "  ledger:  $(grep '^FLEET_LEDGER_PATH=' "$ENV_FILE" | cut -d= -f2-)"
echo "  next:    set ATTIO_API_KEY in $ENV_FILE if HTTP Attio writes/reads are required"
  echo "  check:   curl -sS -X POST \"\${FLEET_OS_URL:-http://127.0.0.1:8787}\" -H 'content-type: application/json' -d '{\"action\":\"readiness\"}'"
  echo "  worker:  cd $ROOT && npx tsx fleet-worker.ts --worker <workerId> --advertise $MACHINE_ID"
