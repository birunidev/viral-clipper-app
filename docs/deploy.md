# Deploy — Web + Backend via `docker-compose.yml`

This stack deploys **only** with `docker-compose.yml` (no overlay files). Caddy runs **on the host**, not in Docker, and terminates TLS + proxies loopback-only ports.

## Topology

```
Internet:80/443 → Caddy (host) → 127.0.0.1:3005 (web) + 127.0.0.1:8000 (backend)
                               ↘ 127.0.0.1:3005/*   + /api/v1/* → 127.0.0.1:8000
                    ↘ internal: postgres:5432 (no published ports)
                                   + pot:4416 (sidecar, internal only, optional)
```

`docker-compose.yml:3` header: Caddy is host-level. `Caddyfile:1` proxies `/api/*` → `127.0.0.1:8000`, else → `127.0.0.1:3005`. DB is internal-only (`docker-compose.yml:32` caps, no `ports` for `postgres`).

All other composes (`docker-compose.dev.yml`, `gpu.yml`, `local*.yml`) are **not** used in prod.

---

## Prerequisites — VM

- Ubuntu 22.04+ VM with public IP, domain `clipzard.web.id` DNS `A → VM` (as in `CLIENT_RENDER_HANDOFF.md` + `Caddyfile:16`).
- `docker` + `docker compose` plugin, `git`, host `caddy` (`sudo apt install docker.io docker-compose-plugin caddy` or `docker-ce` + Caddy repo).
- ACME email `hello@birunidev.com` (or yours) in `Caddyfile:17` for Let's Encrypt.
- Open **80/443** in firewall; **do not** expose `8000`/`3005`/`5432` publicly.

---

## 1. Clone

```bash
mkdir -p ~/apps && cd ~/apps
git clone <your-repo> clipzard && cd clipzard
```

Place `Caddyfile` at `~/apps/clipzard/Caddyfile` (or `/etc/caddy/Caddyfile` — update path below accordingly). Host Caddy reads it, not the compose file.

---

## 2. Env (only `docker-compose.yml` + `backend/.env` / `.env`)

### 2a. Project-root `.env` (required: `docker-compose.yml:22`)

```bash
cat > .env <<'EOF'
POSTGRES_PASSWORD=replace-with-a-strong-password
# optional overrides (defaults: clipforge):
# POSTGRES_USER=clipforge
# POSTGRES_DB=clipforge
EOF
```

> Keep `POSTGRES_USER=clipforge` (`docker-compose.yml:13` comment). Existing `pgdata` volume was init'd with this role — renaming breaks auth.

### 2b. Backend `backend/.env` (from `backend/.env.example:1`)

```bash
cp backend/.env.example backend/.env
# then edit — minimum prod set:
```

```ini
DATABASE_URL=postgresql://clipforge:YOUR_PASSWORD@postgres:5432/clipforge
# FastAPI overrides DATABASE_URL to postgres:5432 internally (docker-compose.yml:104),
# so any host-local URL in backend/.env is ignored in compose.

APP_SECRET_KEY=openssl rand -hex 32   # 32+ chars, stable — BYOK keys become undecryptable if changed
FRONTEND_URLS=https://clipzard.web.id
NEXT_PUBLIC_API_URL=https://clipzard.web.id/api/v1
ELECTRON_ALLOW_NULL_ORIGIN=1
S3_BUCKET=your-r2-bucket
S3_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=auto
# update publish (used by CI + scripts/upload-release.mjs:46):
CLIPZARD_API_KEY=openssl rand -hex 32  # same value as GH Secret, see docs/ci.md
CLIPZARD_DOWNLOAD_SIGN_SECRET=   # optional HMAC, leave empty to disable

# prod cookie hardening (behind Caddy TLS):
# COOKIE_SECURE=1

# billing / Paddle / Midtrans as needed (see backend/.env.example:135):
# PADDLE_API_KEY= ...
# PADDLE_ENV=production
```

Set `FRONTEND_URLS` to your domain — `backend/app/main.py:72` checks `Origin`, browser `withCredentials` needs it.

### 2c. Web `web/.env` (optional)

For compose, `NEXT_PUBLIC_API_URL` is passed as build-arg (`docker-compose.yml:172` `NEXT_PUBLIC_API_URL`). If you keep a file:

```bash
echo 'NEXT_PUBLIC_API_URL=https://clipzard.web.id/api/v1' > web/.env
```

`backend/.env` is the only `env_file` compose uses (`docker-compose.yml:96`); root `.env` supplies Postgres creds to compose directly.

---

## 3. Build & run (web + backend)

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend web  # tail
```

What builds:

- `backend` `Dockerfile` → FastAPI + Alembic; `backend` healthcheck `GET /health` (`docker-compose.yml:148`), depends on `postgres:healthy` + `pot:started`.
- `web` `Dockerfile` / `web/package.json` → Next.js (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GA_ID` build-args at `docker-compose.yml:169`); healthcheck `GET /` (`docker-compose.yml:198`).
- `postgres` `postgres:16-alpine` with `pgdata:/var/lib/postgresql/data` (`docker-compose.yml:25`), capabilities as commented at `docker-compose.yml:36`, memory limit `1g`.
- `pot` `bgutil-ytdlp-pot-provider:latest` on `http://pot:4416` internal (`docker-compose.yml:60`), only when `ENABLE_YTDLP=1` actually uses it.

First boot runs migrations (`backend` entrypoint `poetry run alembic upgrade head` per `README.md:221`; verified in image, not needed manually). To force:

```bash
docker compose exec backend poetry run alembic upgrade head
# or ./run.sh migrate --prod (wraps the same)
```

---

## 4. Host Caddy

Install if not present, then host Caddy (not `docker compose`):

```bash
sudo apt install -y caddy
sudo caddy fmt --overwrite Caddyfile          # optional format
sudo caddy validate --config Caddyfile || true
# place if not in ~/apps/clipzard:
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo caddy reload --config /etc/caddy/Caddyfile
# or file from repo: sudo caddy reload --config ~/apps/clipzard/Caddyfile
```

`Caddyfile:3` publishes loopback-only ports, so `http://clipzard.web.id` → Caddy → `127.0.0.1:3005/8000`. TLS auto via ACME (`Caddyfile:16`). Security headers, CSP, scanner blocking (`Caddyfile:22`), body cap `25MB` (`Caddyfile:74`) with `2GB` override for `POST /api/v1/update/upload` (`Caddyfile:117`), rate limits `200/10s` global + `1/5m` for upload, `60/1m` for feed/check (`Caddyfile:87`), all present.

Firewall: `sudo ufw allow 80,443/tcp` only — never `8000`/`3005`.

---

## 5. Verify

```bash
curl -sf http://127.0.0.1:8000/health | jq
# {"ok":true,"service":"clipzard-backend","ytdlp_version":"…"}
curl -sf http://127.0.0.1:3005/ -o /dev/null -w "%{http_code}\n"
curl -sf https://clipzard.web.id/health | jq        # via Caddy
curl -sf https://clipzard.web.id/api/v1/update/check?version=0.0.0\&platform=linux\&arch=x64\&channel=stable -v

# DB connectivity inside compose
docker compose exec postgres psql -U clipforge -d clipforge -c "select 1"
```

If `GET /update/check` 404s with `no published update` the feed is correct — publish one via `scripts/upload-release.mjs` (see `docs/ci.md`).

---

## 6. Publish updates (web not needed)

Tag push → `.github/workflows/release.yml:69` `Publish update (CLIPZARD_API_KEY)` auto-`POST /api/v1/update/upload` (see `docs/ci.md`/`docs/ci.yml`). Manual:

```bash
node scripts/upload-release.mjs \
  --file=electron/release/ClipZard\ Setup\ 0.2.0.exe \
  --version=0.2.0 --platform=win32 --arch=x64 \
  --api=https://clipzard.web.id --api-key=$CLIPZARD_API_KEY
```

---

## 7. Ops

```bash
docker compose logs -f backend               # FastAPI/ytdlp
docker compose logs -f web                   # Next.js
docker compose restart backend               # after backend/.env change
docker compose down && docker compose up -d --build  # full rebuild
docker volume ls | grep pgdata              # DB persistence
# never commit real .env — keep backend/.env out of git (.gitignore)
```

Caddy: `sudo caddy reload --config /etc/caddy/Caddyfile` after `Caddyfile` changes; `sudo journalctl -u caddy -f`.

Rollback: `git checkout <prev-tag> && docker compose up -d --build`; Alembic downgrades not auto-run — `docker compose exec backend poetry run alembic downgrade -1` only if needed.

---

## Env checklist (copy to ticket)

- [ ] `.env` `POSTGRES_PASSWORD` set
- [ ] `backend/.env` `DATABASE_URL`, `APP_SECRET_KEY`, `S3_*`, `FRONTEND_URLS=https://clipzard.web.id`, `CLIPZARD_API_KEY`, `ELECTRON_ALLOW_NULL_ORIGIN=1`
- [ ] `Caddyfile` domain/ACME email matches DNS
- [ ] `docker compose up -d --build` green, both healthchecks `healthy`
- [ ] `https://clipzard.web.id` + `https://clipzard.web.id/health` return 200 via Caddy
