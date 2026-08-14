# ClipForge

Desktop app that finds viral moments in long videos and cuts vertical 9:16 clips.

## Prerequisites

- Python 3.10+
- [Poetry](https://python-poetry.org/)
- FFmpeg on the system PATH (`ffmpeg -version` to verify)

## Setup

```bash
poetry install
poetry run python main.py
```

### AssemblyAI audio upload (S3 / R2, optional)

The extracted audio is uploaded to S3 (or Cloudflare R2) and AssemblyAI is
handed a presigned URL. If not configured it falls back to AssemblyAI's own
upload endpoint. Configure via environment variables or a `.env` file (see
`.env.example`):

```bash
export S3_BUCKET=your-bucket-name
# Cloudflare R2: https://<account-id>.r2.cloudflarestorage.com
export S3_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=auto
# optional for temp credentials:
export AWS_SESSION_TOKEN=...
```

For plain Amazon S3, omit `S3_ENDPOINT_URL`. A `.env` file in the project
root is loaded automatically on launch; it is git-ignored. The bucket needs
`s3:PutObject` and `s3:DeleteObject`; the presigned GET URL lets AssemblyAI
fetch the audio, and the uploaded object is deleted from the bucket
automatically once transcription finishes.

## How it works

1. **Source** — pick a local video file or paste a YouTube URL; remote videos are
   downloaded first (via yt-dlp, capped at 1080p). If YouTube returns HTTP 403
   (bot detection) the download retries with alternate player clients.
2. **Transcribe** — the video's audio is extracted with FFmpeg, uploaded
   (to S3 if configured, otherwise AssemblyAI), then transcribed by AssemblyAI.
3. **Analyze** — an OpenAI-compatible LLM (OpenAI, Groq, Ollama, ...) finds viral
   moments and returns clip timestamps as JSON.
4. **Cut** — FFmpeg trims each moment and crops it to the chosen ratio (9:16, 16:9,
   or original), saving clips to `outputs/<video>/`.

API keys are stored locally in `config.json` (plaintext, not encrypted) and are
reused on next launch.

### YouTube downloads

- Downloads are capped at 1080p for speed; retries alternate player clients on
  HTTP 403.
- If a video is age-restricted or blocked without login, export your browser
  cookies to a Netscape file and point to it:

  ```bash
  export YTDLP_COOKIEFILE=/path/to/cookies.txt
  ```

  (e.g. the "Get cookies.txt LOCALLY" browser extension).

## Tests

```bash
poetry run pytest
```
