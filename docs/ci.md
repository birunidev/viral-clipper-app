# CI — Build & Auto-Publish Updates

Release builds run on **GitHub Actions** (`release.yml`) and optionally auto-publish update binaries to `https://clipzard.web.id/api/v1/update/*` via `CLIPZARD_API_KEY` (`X-API-Key`).

Workflow: `.github/workflows/release.yml`
- Matrix: `ubuntu-latest --linux`, `windows-latest --win`, `macos-14 --mac` (arm64)
- Binary prep: `cmake` + `build-essential` (linux/mac), whisper prebuilt ZIP on Windows, `prepare-build --skip-models` → `resources/bin/<plat>-<arch>/whisper-cli`
- Artifact: `electron/release/*.{AppImage,deb,exe,dmg,zip}`
- Publish (tags only): `scripts/upload-release.mjs` → `POST /update/upload`

Electron auto-update: `electron/src/main.ts:274` `generic` provider → `GET /api/v1/update-feed/{platform}/{arch}/{channel}.yml` + `GET /update/download` (backend `backend/app/api/updates.py:181`).

---

## One-time GitHub setup

### 1. Create `CLIPZARD_API_KEY`

```bash
openssl rand -hex 32
# bac22bdb35fa32f40f5deb66d2bd690443f35ad1300449a60b61e1450884effc
```

On server add to `backend/.env` (already present) and restart:

```bash
echo 'CLIPZARD_API_KEY="bac22bdb35fa32f40f5deb66d2bd690443f35ad1300449a60b61e1450884effc"' >> backend/.env
# or edit backend/.env.example then deploy
docker compose restart backend  # or systemctl depending on your deploy
# verify: curl -H "X-API-Key: bac22b..." https://clipzard.web.id/api/v1/update/admin-status
# -> {"is_admin":true}
```

### 2. Add GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value | Notes |
|---|---|---|
| `CLIPZARD_API_KEY` | same hex as `backend/.env` | Required for tag publish step |
| `CLIPZARD_API_URL` | _(optional)_ `https://clipzard.web.id` | Defaults to this; override only for staging |
| `GH_TOKEN` | _(already set)_ | electron-builder GitHub publish (currently `never`, kept for signing) |
| `APPLE_ID`, `APPLE_ID_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD` | _(already set)_ | mac/win signing if configured |

Permissions: repo **Actions → General → Workflow permissions → Read and write permissions** (for `upload-artifact`).

### 3. Verify workflow file

`.github/workflows/release.yml` should contain (recently added):

```yaml
- name: Publish update (CLIPZARD_API_KEY)
  if: startsWith(github.ref, 'refs/tags/v')
  run: node ../scripts/upload-release.mjs --file="$FILE" --version="$VERSION" --platform="$PLATFORM" --arch="$ARCH" --channel="..."
  env:
    CLIPZARD_API_KEY: ${{ secrets.CLIPZARD_API_KEY }}
    CLIPZARD_API_URL: ${{ secrets.CLIPZARD_API_URL }}
```

---

## Release flow — step by step

### A. Prepare version

1. Bump `electron/package.json` `version` (semver `0.3.0`, beta `0.3.0-beta.1` → beta channel).
2. Commit:
   ```bash
   git add electron/package.json
   git commit -m "chore: bump to v0.3.0"
   git push origin main
   ```

### B. Tag & push (triggers CI)

```bash
git tag v0.3.0
git push origin v0.3.0
# beta: git tag v0.3.0-beta.1 && git push origin v0.3.0-beta.1
```

Checks:

- GitHub → **Actions → release** → matrix jobs `clipzard-ubuntu-latest / windows-latest / macos-14` go green.
- Each job uploads artifact + calls `scripts/upload-release.mjs`:
  - `ubuntu → linux/x64 → *.AppImage` (picked via `ls electron/release/*.AppImage | head -n1`)
  - `windows → win32/x64 → *.exe`
  - `macos-14 → darwin/arm64 → *.dmg` (fallback `*.zip`)
  - `IS_BETA=true` if version contains `-`.

### C. Verify publish

```bash
# feed now exists per platform
curl https://clipzard.web.id/api/v1/update-feed/linux/x64/stable.yml
curl https://clipzard.web.id/api/v1/update-feed/win32/x64/stable.yml
curl "https://clipzard.web.id/api/v1/update/check?version=0.0.0&platform=win32&arch=x64&channel=stable"

# admin list (requires API key)
curl -H "X-API-Key: $CLIPZARD_API_KEY" https://clipzard.web.id/api/v1/update/list | jq

# delete/re-publish if needed
curl -X DELETE -H "X-API-Key: $CLIPZARD_API_KEY" https://clipzard.web.id/api/v1/update/<id>
# or re-run upload: same (platform,arch,version,is_beta) overwrites S3 + row
```

Electron clients detect: packaged `CLIPZARD_UPDATE_URL=https://clipzard.web.id` → `main.ts:275` polls `…/update-feed/{platform}/{arch}/{stable|beta}.yml` 5s after launch then every 6h → dialog **Download → Restart now**.

### D. Manual / rerun upload without new tag

Local:

```bash
CLIPZARD_API_KEY=bac22b... node scripts/upload-release.mjs \
  --file=electron/release/ClipZard\ Setup\ 0.3.0.exe \
  --version=0.3.0 --platform=win32 --arch=x64 --channel=stable
```

CI retry: **Actions → release → Re-run failed jobs** (same tag) re-uploads (upserts).

---

## Manual trigger without tag

`Actions → release → Run workflow` builds artifacts but **does not publish** (condition is tag-only). To publish a non-tag manual build, add dispatch input or push a `v*` tag.

## Local dry-run (no GitHub)

```bash
npm ci --prefix electron
npx tsc --prefix electron  # or npx tsc -p electron/tsconfig.json
node electron/scripts/prepare-build.mjs --skip-models
node -e "import('./electron/dist/services/deps.js').then(m=>console.log(m.getDepsStatus()))"
npx --prefix electron electron-builder --linux  # or --win on Windows
ls electron/release/
```

## Troubleshooting

- `401 Invalid API key` → `CLIPZARD_API_KEY` mismatch between GitHub Secret and server `backend/.env`; restart backend after changing env.
- `500 CLIPZARD_API_KEY not configured` → server env missing; add and restart.
- `429 rate limited, retry in …` → upload is `1/IP/5min` (`backend/app/api/updates.py:473`, Caddy `Caddyfile:85`); wait.
- `403 invalid signature` on download → `CLIPZARD_DOWNLOAD_SIGN_SECRET` mismatch (optional HMAC, leave empty to disable).
- Feed 404 `no published update` → that `(platform,arch,channel)` has no published row yet; publish at least one per combo.
- `MISSING ffmpeg/whisper` in Verify deps step → `npm ci` in `electron/` missed `ffmpeg-static`; build deps missing `cmake`/`build-essential` on ubuntu.
