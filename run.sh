#!/usr/bin/env bash
#
# ClipForge — one command to run the whole stack (cloud or fully local).
#
# Usage:
#   ./run.sh up                    # dev stack, cloud providers (AssemblyAI + hosted LLM)
#   ./run.sh up --local            # dev stack, fully local models (whisper.cpp + Ollama)
#   ./run.sh up --prod             # production stack (Caddy/TLS), cloud providers
#   ./run.sh up --prod --local     # production stack, fully local models
#   ./run.sh down [--prod]         # stop the stack
#   ./run.sh logs [--prod]         # tail logs
#   ./run.sh prisma [--prod]       # create/update the DB schema (prisma db push)
#   ./run.sh pull-model [--prod]   # pre-pull the Ollama model without starting jobs
#
# GPU: when --local runs on Linux with an NVIDIA GPU and
# nvidia-container-toolkit installed, Ollama is accelerated automatically.
# Force this detection with FORCE_GPU=1 (on) or FORCE_GPU=0 (off).
#
# .env files are created from the examples on first run — edit them before
# starting. Cloud mode needs real API keys; local mode does not (Ollama
# ignores the API key, whisper.cpp runs fully offline).
set -euo pipefail

cd "$(dirname "$0")"

ensure_env_files() {
  if [ ! -f backend/.env ]; then
    cp backend/.env.example backend/.env
    echo "created backend/.env — edit it before running in cloud mode"
  fi
  if [ ! -f web/.env ]; then
    cp web/.env.example web/.env
    echo "created web/.env — edit it before running"
  fi
}

has_nvidia_gpu() {
  if [ "${FORCE_GPU:-}" = "1" ]; then return 0; fi
  if [ "${FORCE_GPU:-}" = "0" ]; then return 1; fi
  command -v nvidia-smi >/dev/null 2>&1 || [ -f /proc/driver/nvidia/version ]
}

# Builds the list of -f <file> compose args for the requested mode/flags
# into the global array COMPOSE_ARGS.
build_compose_args() {
  local mode="$1" local_models="$2"
  COMPOSE_ARGS=()

  if [ "$mode" = "prod" ]; then
    COMPOSE_ARGS+=(-f docker-compose.yml)
    if [ "$local_models" = "yes" ]; then
      COMPOSE_ARGS+=(-f docker-compose.local-prod.yml)
    fi
  else
    COMPOSE_ARGS+=(-f docker-compose.dev.yml)
    if [ "$local_models" = "yes" ]; then
      COMPOSE_ARGS+=(-f docker-compose.local.yml)
    fi
  fi

  if [ "$local_models" = "yes" ] && has_nvidia_gpu; then
    echo ">> NVIDIA GPU detected — enabling GPU passthrough for Ollama" >&2
    COMPOSE_ARGS+=(-f docker-compose.gpu.yml)
  elif [ "$local_models" = "yes" ]; then
    echo ">> No NVIDIA GPU detected — Ollama will run on CPU" >&2
  fi
}

parse_flags() {
  MODE="dev"
  LOCAL_MODELS="no"
  for arg in "$@"; do
    case "$arg" in
      --local) LOCAL_MODELS="yes" ;;
      --prod)  MODE="prod" ;;
      *) echo "Unknown flag: $arg" >&2; exit 1 ;;
    esac
  done
}

cmd_up() {
  parse_flags "$@"
  ensure_env_files
  build_compose_args "$MODE" "$LOCAL_MODELS"

  if [ "$LOCAL_MODELS" = "yes" ]; then
    echo ">> Starting in $MODE mode with LOCAL models (whisper.cpp + Ollama)"
  else
    echo ">> Starting in $MODE mode with CLOUD providers (AssemblyAI + hosted LLM)"
  fi

  docker compose "${COMPOSE_ARGS[@]}" up -d --build

  echo ""
  if [ "$MODE" = "dev" ]; then
    echo ">> Web:     http://localhost:3000"
    echo ">> Backend: http://localhost:8000"
    [ "$LOCAL_MODELS" = "yes" ] && echo ">> Ollama:  http://localhost:11434"
    echo ""
    echo "First time on this database? Run: ./run.sh prisma"
  else
    echo ">> Production stack started. Caddy serves :80/:443 — set your"
    echo ">> domain in Caddyfile first."
    echo "First time on this database? Run: ./run.sh prisma --prod"
  fi
}

cmd_down() {
  parse_flags "$@"
  build_compose_args "$MODE" "$LOCAL_MODELS"
  docker compose "${COMPOSE_ARGS[@]}" down
}

cmd_logs() {
  parse_flags "$@"
  build_compose_args "$MODE" "$LOCAL_MODELS"
  docker compose "${COMPOSE_ARGS[@]}" logs -f --tail=100
}

cmd_prisma() {
  parse_flags "$@"
  build_compose_args "$MODE" "$LOCAL_MODELS"
  docker compose "${COMPOSE_ARGS[@]}" run --rm web npx prisma db push
}

cmd_pull_model() {
  parse_flags "$@"
  build_compose_args "$MODE" "yes"
  docker compose "${COMPOSE_ARGS[@]}" up -d ollama
  echo ">> Waiting for Ollama and pulling the model (this can take a while)..."
  docker compose "${COMPOSE_ARGS[@]}" exec ollama sh -c \
    'until ollama list >/dev/null 2>&1; do sleep 1; done; ollama pull "${OLLAMA_MODEL:-qwen2.5:7b-instruct-q4_K_M}"'
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local action="${1:-help}"
  shift || true
  case "$action" in
    up)         cmd_up "$@" ;;
    down)       cmd_down "$@" ;;
    logs)       cmd_logs "$@" ;;
    prisma|migrate) cmd_prisma "$@" ;;
    pull-model) cmd_pull_model "$@" ;;
    help|-h|--help) usage ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
