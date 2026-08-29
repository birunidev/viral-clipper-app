#!/bin/sh
# Ollama entrypoint: start the server, pull the configured model if missing,
# then keep serving. Mirrors the upstream image's default entrypoint but
# adds the one-time model pull so the backend's first job doesn't fail with
# "model not found". The model list pull is idempotent and skipped when the
# model is already present.
set -e

MODEL="${OLLAMA_MODEL:-qwen2.5:7b-instruct-q4_K_M}"

# Start the server in the background, then wait for the API to come up.
ollama serve &
until ollama list >/dev/null 2>&1; do sleep 1; done

# Pull once at startup; ollama skips this fast if the model already exists.
echo "Ensuring model '${MODEL}' is present..."
ollama pull "${MODEL}"

# Keep the server running in the foreground (PID 1 contract).
wait
