# ClipZard Desktop (Electron)

Fully local viral clip engine — Electron main + Vite renderer + Node pipeline (ffmpeg + yt-dlp + whisper.cpp + Qwen GGUF).

Pure Node pipeline by default (`electron/src/services/pipeline.ts:48`). No Python, no Postgres, no Docker required. Embedded FastAPI is opt-in only.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node | `22.23.2` (see `.nvmrc`, `engines >=20.18.0 <24`) | `node:sqlite` (`DatabaseSync`) needs Node 22.5+; older falls back to JSON |
| npm | 10+ | |
| OS | Linux / macOS / Windows | Linux tested on Ubuntu 24.04 |
| ffmpeg | auto via `ffmpeg-static` npm | System `ffmpeg` is fallback |
| yt-dlp | auto via `yt-dlp-exec` | System `yt-dlp` is fallback |
| whisper.cpp binary | `whisper-cli` in `resources/bin/<plat>-<arch>/` | If missing, transcriber uses mock data (dev) |
| Qwen GGUF + whisper GGML | auto-download to `userData/models/` | Installer / first-run lazy download |

> No `cmake` / `build-essential` needed unless you enable `node-llama-cpp` native rebuild (`npm run rebuild`).

---

## Quick Start (dev)

```bash
# 1. Pin Node (nvm)
nvm use           # reads .nvmrc (22.23.2) — or: fnm use / volta pin

# 2. Install deps (two package.json — main + renderer)
cd electron
npm install                 # electron main: also fixes chrome-sandbox perms
npm --prefix renderer install

# 3. Env (optional — all vars are optional for dev)
cp .env.example .env        # edit only if you need cloud LLM or local overrides

# 4. Run (concurrently: tsc watch + preload esbuild + Vite + Electron)
npm run dev
# Vite: http://localhost:5173
# Electron loads ELECTRON_DEV_URL, opens DevTools detached

# Alternatives
npm run dev:renderer        # Vite alone
npm run dev:electron        # Electron against built renderer (run renderer build first)
npm run typecheck           # main
npm run typecheck:renderer  # renderer
npm --prefix renderer run build  # produce renderer/dist
```

**Dev bypass:** `LICENSE` check is bypassed when `app.isPackaged === false` (`src/services/license.ts:6`). `Checking license…` gate in `renderer/src/main.tsx:20` will auto-pass.

**Data location:** `app.getPath('userData')` →

- Linux: `~/.config/clipzard-desktop/clipzard.db` (+ `projects/`, `models/`)
- macOS: `~/Library/Application Support/clipzard-desktop/`
- Win: `%APPDATA%\clipzard-desktop\`

Override with `USER_DATA_PATH=/tmp/clipzard-data npm run dev`.

---

## Pure Node Pipeline — 100% Working Locally

Pipeline stages (`src/services/pipeline.ts`):

1. **download** (`src/services/youtube.ts:44`) — `yt-dlp` → temp → copy to `userData/projects/<id>/source.mp4`, `media://` protocol serves it (`src/main.ts:78`)
2. **transcribe** (`src/services/transcriber.ts:99`) — `ffmpeg` extract wav → `whisper-cli` (`resources/bin/<plat>-<arch>/whisper-cli`) → `timeline_words` table. **Without binary → mock transcript** (so dev never breaks)
3. **analyze** (`src/services/analyzer.ts:197`) — If `LLM_API_KEY+LLM_BASE_URL` set → OpenAI-compatible; else `node-llama-cpp` local GGUF (`userData/models/llm/*.gguf`); **without model → mock clips**
4. **render** (`src/services/cutter.ts:57`) — `ffmpeg` cut + crop + ASS captions (`src/services/captions.ts:102`)

For a bulletproof local dev without any downloads:

- `ffmpeg-static` + `yt-dlp-exec` already npm-installed handle 90% — just run `npm install`.
- `whisper-cli` binary is the only extra for real transcription. If you don't have it, the mock still lets you exercise the full UI/al.pipeline (3 clips, timeline). Add a real `whisper-cli` under `resources/bin/linux-x64/` to go fully real without code changes.

---

## Models — Downloaded at Installer / First Run

Models are **not** bundled in the installer by default (keeps installer ~150 MB vs +2–8 GB). They are lazily downloaded on first `transcribe`/`analyze`:

- `transcriber.ts:39` → `ensureModel()` → `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<base|small|medium>.bin` → `userData/models/whisper/ggml-*.bin`
- `analyzer.ts:147` → `ensureLlmModel()` → Qwen GGUF → `userData/models/llm/*.gguf` (low: Qwen official `qwen2.5-3b-q4_k_m`, mid/high: `bartowski` single-file builds to avoid sharded 2-file GGUFs)

Selected by RAM tier (`src/services/system.ts:5`):

| Tier | RAM | whisper | LLM |
|---|---|---|---|
| low | <12 GB | `base` (~140 MB) | `qwen2.5-3b-q4_k_m.gguf` (~2 GB, Qwen official) |
| mid | 12–20 GB | `small` (~460 MB) | `Qwen2.5-7B-Instruct-Q4_K_M.gguf` (~4.7 GB, bartowski) |
| high | ≥20 GB | `medium` (~1.5 GB) | `Qwen2.5-14B-Instruct-Q4_K_M.gguf` (~8.5 GB, bartowski) |

**Pre-seed for offline / faster installer:**

```bash
# download for this machine's tier into its userData (~/.config/clipzard-desktop/models)
npm run models:download

# all tiers (for universal installer staging)
npm run models:download:all

# custom staging dir (to bundle into installer via extraResources)
node scripts/download-models.mjs --out=resources/models --tier=low
# then uncomment the extraResources block in electron-builder.yml
```

The download script is resumable (skips if file exists & >1 MB), shows progress, follows HF redirects.

### Real local AI (whisper.cpp + Qwen GGUF)

Pure Node pipeline can use **real** whisper + LLM locally (no API keys). One command prepares both:

```bash
# Ubuntu/Debian prereqs (once):
sudo apt update && sudo apt install -y cmake build-essential git curl
# ensure python -> python3 for yt-dlp postinstall:
ln -sf /usr/bin/python3 /tmp/python && export PATH="/tmp:$PATH"

# Full setup: build whisper-cli + download models for this tier + rebuild node-llama-cpp + verify
npm run setup:local-ai                 # auto tier (ramTier)
npm run setup:local-ai -- --tier=low   # force small model for testing (fast, ~2GB)

# Sub-steps:
npm run setup:whisper                  # only build whisper-cli -> resources/bin/linux-x64/whisper-cli
npm run setup:models                   # only download GGML/GGUF -> userData/models/
npm run rebuild                        # only rebuild node-llama-cpp native

# Verify real mode (after setup, no mocks):
node electron/scripts/verify-pipeline.mjs --keep   # should show real words/clips, not mock fallback
# Check logs: should NOT see "[transcriber] whisper binary not found" nor "[analyzer] local failed, using mock"
```

**How it works:**
- `whisper-cli` is built from `ggerganov/whisper.cpp` (`cmake`) into `resources/bin/<platform>-<arch>/whisper-cli` (`src/services/bin.ts:91`). If binary missing, pipeline falls back to mock — so dev never breaks.
- LLM via `node-llama-cpp@3.6.0` (optionalDependency). If `LLM_API_KEY`+`LLM_BASE_URL` are set in `.env`, cloud is used instead (`analyzer.ts:202`); unset them to force local GGUF.
- Models live at `<userData>/models/...` (`~/.config/clipzard-desktop/models/` on Linux). Override `USER_DATA_PATH` to stage elsewhere. The installer can pre-seed `resources/models/` and copy on first run (see `electron-builder.yml:15`).
- To force re-download: `rm -rf ~/.config/clipzard-desktop/models` then `npm run setup:models`.

---

## Environment

See `.env.example`. Common:

```bash
# Cloud LLM instead of local GGUF (higher quality):
LLM_BASE_URL=https://ai.sumopod.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-v4-flash

# Pin whisper / LLM:
WHISPER_MODEL=small
LLM_MODEL_FILE=qwen2.5-7b-q4_k_m.gguf
LLM_MODEL_URL=https://...

# Embedded FastAPI (off by default):
USE_FASTAPI_LOCAL=1

# License server (optional, only if you run a real verifier):
LICENSE_VERIFY_URL=https://clipzard.web.id/api/license/verify
```

---

## Build

```bash
npm --prefix renderer run build   # must precede electron build
npm run build                     # auto target (current OS)
npm run build:linux               # AppImage + deb → release/
npm run build:win                 # nsis (requires Windows or wine)
npm run build:mac                 # dmg + zip (requires macOS)
```

Builder config: `electron-builder.yml` (`appId com.clipzard.desktop`). Binaries under `resources/bin/<plat>-<arch>/` are auto-included as `extraResources/bin`.

---

## Troubleshooting

- **Vite not reachable** (`did-fail-load`): `wait-on http://localhost:5173` in `package.json:11` ensures order; check port free, run `npm run dev:renderer` separately.
- **chrome-sandbox permission denied (Linux)**: `postinstall` does `chmod 4755`; re-run `npm install` or `sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.
- **yt-dlp 403 / bot guard**: Try `Upload` instead of YouTube URL, or retry (yt-dlp fallback chain). On dev, bot guard surfaces as `DownloadError` hint.
- **whisper/LLM large download stalls**: Check disk space, re-run `npm run models:download`; partial files are skipped only if >1 MB, delete to retry.
- **DB locked / JSON fallback**: Node <22.5 can't load `node:sqlite` → JSON file at `clipzard.json` is used (`src/services/db.ts:278`). Upgrade Node or set `USER_DATA_PATH` to a writable dir.
- **`media://` 403**: Path must be under `userData/projects` or `os.tmpdir()` (`src/main.ts:58`); renderer gets URLs via `toMediaUrl()` (`main.ts:135`).
