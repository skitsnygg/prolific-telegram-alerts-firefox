#!/bin/bash
set -euo pipefail

LABEL="com.brian.prolific-alerts-local"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
REPO_DIR="${HOME}/prolific-telegram-alerts-firefox"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SCRIPT="${SCRIPT_DIR}/start-local-services.sh"
GUI_DOMAIN="gui/$(id -u)"

mkdir -p "${PLIST_DIR}"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${START_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${REPO_DIR}</string>
  </dict>
</plist>
EOF

launchctl bootout "${GUI_DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl bootstrap "${GUI_DOMAIN}" "${PLIST_PATH}"
launchctl kickstart -k "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

echo "Installed LaunchAgent: ${PLIST_PATH}"
echo "The API and bot will start automatically when you log in."
