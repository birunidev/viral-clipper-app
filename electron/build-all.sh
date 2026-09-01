#!/usr/bin/env bash
set -euo pipefail

# ClipZard — Docker-only multi-platform build
# Produces AppImage/deb (linux), nsis exe (win), dmg/zip (mac, unsigned) via electron-builder
# Usage: ./build-all.sh [linux|win|mac|all]  (default: all)
# Requires: Docker only (no host npm/wine)
# Output: release/ + SHA512SUMS

TARGET="${1:-all}"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.1.0")"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

case "$TARGET" in
  linux|win|mac|all) ;;
  *) echo "Usage: $0 [linux|win|mac|all]"; exit 1 ;;
esac

run_linux() {
  echo "==> Building linux (AppImage + deb) — node:22-alpine"
  docker run --rm -v "$PROJECT_ROOT:/app" -w /app node:22-alpine sh -c "
    npm ci --ignore-scripts
    npm --prefix renderer ci --ignore-scripts || npm --prefix renderer install
    npm run build:linux -- --publish never
  "
  ls -lh "$PROJECT_ROOT/release/"* 2>/dev/null | grep -E "AppImage|deb" || true
}

run_win() {
  echo "==> Building win (nsis) — electronuserland/builder:wine"
  docker run --rm -v "$PROJECT_ROOT:/app" -w /app electronuserland/builder:wine sh -c "
    npm ci --ignore-scripts
    npm --prefix renderer ci --ignore-scripts || npm --prefix renderer install
    npm run build:win -- --publish never
  "
  ls -lh "$PROJECT_ROOT/release/"* 2>/dev/null | grep -E "\.exe" || true
}

run_mac() {
  echo "==> Building mac (dmg + zip, unsigned) — electronuserland/builder:wine"
  echo "    NOTE: unsigned dmg will be blocked by Gatekeeper — for distribution use macOS + Apple cert"
  docker run --rm -v "$PROJECT_ROOT:/app" -w /app electronuserland/builder:wine sh -c "
    npm ci --ignore-scripts
    npm --prefix renderer ci --ignore-scripts || npm --prefix renderer install
    npm run build:mac -- --publish never
  "
  ls -lh "$PROJECT_ROOT/release/"* 2>/dev/null | grep -E "dmg|zip" || true
}

mkdir -p "$PROJECT_ROOT/release"

case "$TARGET" in
  linux) run_linux ;;
  win)   run_win ;;
  mac)   run_mac ;;
  all)   run_linux; run_win; run_mac ;;
esac

echo "==> Checksums"
(cd "$PROJECT_ROOT/release" && sha512sum -- * 2>/dev/null | tee SHA512SUMS | head -n 20 || shasum -a 512 -- * 2>/dev/null | tee SHA512SUMS | head -n 20 || true)

echo ""
echo "Done. Artifacts in electron/release/ (version $VERSION)"
echo "Publish via curl:"
echo "  curl -H \"X-API-Key: \$CLIPZARD_API_KEY\" -F file=@electron/release/<file> -F version=$VERSION -F platform=win32 -F arch=x64 https://clipzard.web.id/api/v1/update/upload"
echo "  curl https://clipzard.web.id/api/v1/update/releases | python -m json.tool"
echo "  curl https://clipzard.web.id/download"
