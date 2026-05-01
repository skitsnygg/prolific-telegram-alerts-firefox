#!/bin/bash
set -euo pipefail

REPO_DIR="${HOME}/prolific-telegram-alerts-firefox"
NODE20_DIR="/opt/homebrew/opt/node@20/bin"
LOG_DIR="${HOME}/Library/Logs"

API_DIR="${REPO_DIR}/apps/api"
BOT_DIR="${REPO_DIR}/apps/bot"

API_ENV_FILE="${API_DIR}/.env"
BOT_ENV_FILE="${BOT_DIR}/.env"

API_ENTRYPOINT="${API_DIR}/dist/index.js"
BOT_ENTRYPOINT="${BOT_DIR}/dist/index.js"

API_LOG_FILE="${LOG_DIR}/prolific-alerts-api.log"
BOT_LOG_FILE="${LOG_DIR}/prolific-alerts-bot.log"

API_PID_FILE="/tmp/prolific-alerts-api.pid"
BOT_PID_FILE="/tmp/prolific-alerts-bot.pid"

if [[ -d "${NODE20_DIR}" ]]; then
  export PATH="${NODE20_DIR}:${PATH}"
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "node was not found. Install Node.js or Homebrew node@20 first." >&2
  exit 1
fi

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "Repository directory not found: ${REPO_DIR}" >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"
touch "${API_LOG_FILE}" "${BOT_LOG_FILE}"

cd "${REPO_DIR}"

find_running_pid() {
  local pid_file="$1"
  local entrypoint="$2"

  if [[ -f "${pid_file}" ]]; then
    local existing_pid
    existing_pid="$(cat "${pid_file}")"
    if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && kill -0 "${existing_pid}" 2>/dev/null; then
      printf '%s\n' "${existing_pid}"
      return 0
    fi
    rm -f "${pid_file}"
  fi

  local found_pid
  found_pid="$(pgrep -f -- "${entrypoint}" | head -n 1 || true)"
  if [[ -n "${found_pid}" ]]; then
    printf '%s\n' "${found_pid}" > "${pid_file}"
    printf '%s\n' "${found_pid}"
    return 0
  fi

  return 1
}

start_service() {
  local service_name="$1"
  local service_dir="$2"
  local env_file="$3"
  local entrypoint="$4"
  local log_file="$5"
  local pid_file="$6"

  local existing_pid
  if existing_pid="$(find_running_pid "${pid_file}" "${entrypoint}")"; then
    echo "${service_name} already running (pid ${existing_pid})"
    return 0
  fi

  if [[ ! -f "${env_file}" ]]; then
    echo "${service_name} env file not found: ${env_file}" >&2
    return 1
  fi

  if [[ ! -f "${entrypoint}" ]]; then
    echo "${service_name} entrypoint not found: ${entrypoint}" >&2
    echo "Build the service first before starting it." >&2
    return 1
  fi

  (
    cd "${service_dir}"
    DOTENV_CONFIG_PATH="${env_file}" nohup "${NODE_BIN}" "${entrypoint}" >> "${log_file}" 2>&1 &
    echo $! > "${pid_file}"
  )

  sleep 1

  local started_pid
  started_pid="$(cat "${pid_file}")"
  if [[ "${started_pid}" =~ ^[0-9]+$ ]] && kill -0 "${started_pid}" 2>/dev/null; then
    echo "Started ${service_name} (pid ${started_pid})"
    return 0
  fi

  rm -f "${pid_file}"
  echo "${service_name} failed to start. Check ${log_file}" >&2
  return 1
}

start_service "API" "${API_DIR}" "${API_ENV_FILE}" "${API_ENTRYPOINT}" "${API_LOG_FILE}" "${API_PID_FILE}"
start_service "Bot" "${BOT_DIR}" "${BOT_ENV_FILE}" "${BOT_ENTRYPOINT}" "${BOT_LOG_FILE}" "${BOT_PID_FILE}"
