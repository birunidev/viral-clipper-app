# ClipForge Web

Next.js app for ClipForge.

- **SSR marketing pages** at `/` — pure content, no server-side data access.
- **Client-only app** at `/app/*` (login, register, dashboard, project
  detail) — all data fetching goes through **React Query** to the FastAPI
  backend (`NEXT_PUBLIC_API_URL`, `/api/v1`). There is no Prisma, no
  Better Auth, no Next.js API routes: every request happens in the browser
  with an httpOnly session cookie set by the backend.

## Run

```bash
cp .env.example .env   # set NEXT_PUBLIC_API_URL to your backend
npm install
npm run dev            # http://localhost:3000
```

## Build

```bash
npm run build && npm run start
```

`NEXT_PUBLIC_API_URL` is inlined at build time (Dockerfile build arg).
