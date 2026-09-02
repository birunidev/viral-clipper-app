# ClipZard — reproducible builder (alternative to build-all.sh docker run)
# Usage:
#   docker build -f electron/Dockerfile.builder --build-arg TARGET=linux -t clipzard:linux .
#   docker build -f electron/Dockerfile.builder --build-arg TARGET=win -t clipzard:win .
#   docker build -f electron/Dockerfile.builder --build-arg TARGET=mac -t clipzard:mac .
#   docker run --rm -v $PWD/electron/release:/out clipzard:linux sh -c "cp release/* /out/"

ARG TARGET=linux
ARG SKIP_LLM=1
ARG SKIP_MODELS=0
FROM electronuserland/builder:wine AS builder
WORKDIR /app
ENV SKIP_LLM=${SKIP_LLM}
ENV SKIP_MODELS=${SKIP_MODELS}
COPY electron/package.json electron/package-lock.json ./
RUN npm ci --ignore-scripts
COPY electron/renderer/package.json electron/renderer/package-lock.json ./renderer/
RUN npm --prefix renderer ci --ignore-scripts || npm --prefix renderer install
COPY electron/ ./
# SKIP_LLM=1 (default) skips multi-GB LLM download — LLM fetched on-demand in installed app via analyzer ensureLlmModel.
# Pass --build-arg SKIP_LLM=0 or --build-arg SKIP_MODELS=0 to bundle LLM offline.
RUN npm run build:${TARGET} -- --publish never
# Artifacts are in /app/release — copy out at runtime via volume
