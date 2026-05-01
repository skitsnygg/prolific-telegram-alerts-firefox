#!/bin/bash
set -euo pipefail

LABEL="com.brian.prolific-alerts-local"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOP_SCRIPT="${SCRIPT_DIR}/stop-local-services.sh"
GUI_DOMAIN="gui/$(id -u)"

launchctl bootout "${GUI_DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl remove "${LABEL}" >/dev/null 2>&1 || true

if [[ -f "${PLIST_PATH}" ]]; then
  rm -f "${PLIST_PATH}"
  echo "Removed LaunchAgent plist: ${PLIST_PATH}"
else
  echo "LaunchAgent plist not present: ${PLIST_PATH}"
fi

"/bin/bash" "${STOP_SCRIPT}"

echo "Disabled macOS auto-start for local services."
