#!/bin/bash
set -euo pipefail

API_PID_FILE="/tmp/prolific-alerts-api.pid"
BOT_PID_FILE="/tmp/prolific-alerts-bot.pid"

stop_service() {
  local service_name="$1"
  local pid_file="$2"

  if [[ ! -f "${pid_file}" ]]; then
    echo "${service_name} is not running (no pid file)"
    return 0
  fi

  local pid
  pid="$(cat "${pid_file}")"

  if [[ ! "${pid}" =~ ^[0-9]+$ ]]; then
    rm -f "${pid_file}"
    echo "${service_name} pid file was invalid and has been removed"
    return 0
  fi

  if ! kill -0 "${pid}" 2>/dev/null; then
    rm -f "${pid_file}"
    echo "${service_name} is not running (stale pid ${pid})"
    return 0
  fi

  kill "${pid}"

  local waited=0
  while kill -0 "${pid}" 2>/dev/null; do
    if [[ "${waited}" -ge 10 ]]; then
      kill -9 "${pid}" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  rm -f "${pid_file}"
  echo "Stopped ${service_name} (pid ${pid})"
}

stop_service "API" "${API_PID_FILE}"
stop_service "Bot" "${BOT_PID_FILE}"
