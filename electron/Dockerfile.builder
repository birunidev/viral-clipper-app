# ClipZard — reproducible builder (alternative to build-all.sh docker run)
# Usage:
#   docker build -f electron/Dockerfile.builder --build-arg TARGET=linux -t clipzard:linux .
#   docker build -f electron/Dockerfile.builder --build-arg TARGET=win -t clipzard:win .
#   docker build -f electron/Dockerfile.builder --build-arg TARGET=mac -t clipzard:mac .
#   docker run --rm -v $PWD/electron/release:/out clipzard:linux sh -c "cp release/* /out/"

ARG TARGET=linux
FROM electronuserland/builder:wine AS builder
WORKDIR /app
COPY electron/package.json electron/package-lock.json ./
RUN npm ci --ignore-scripts
COPY electron/renderer/package.json electron/renderer/package-lock.json ./renderer/
RUN npm --prefix renderer ci --ignore-scripts || npm --prefix renderer install
COPY electron/ ./
RUN npm run build:${TARGET} -- --publish never
# Artifacts are in /app/release — copy out at runtime via volume
