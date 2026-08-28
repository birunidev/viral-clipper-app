import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { app } from "electron";

let proc: ChildProcess | null = null;
let apiUrl: string | null = null;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as net.AddressInfo;
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function getBackendDir(): string {
  const candidates = [
    path.join(process.resourcesPath, "backend"),
    path.join(process.cwd(), "backend"),
    path.join(path.join(__dirname, "..", "..", "backend")),
    path.join(path.join(__dirname, "..", "..", "..", "backend")),
  ];
  for (const p of candidates) if (fs.existsSync(path.join(p, "app", "main.py"))) return p;
  return path.join(process.cwd(), "backend");
}

function getPythonBin(): string {
  if (process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
  const candidates = [
    path.join(getBackendDir(), ".venv", "bin", "python"),
    path.join(os.homedir(), ".cache", "pypoetry", "virtualenvs", "clipforge*"),
    "python3",
    "python",
  ];
  for (const c of candidates) {
    if (c.includes("*")) continue;
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return "python3";
}

export async function startLocalFastAPI(): Promise<string> {
  if (apiUrl && proc && !proc.killed) return apiUrl;
  const port = await getFreePort();
  const backendDir = getBackendDir();
  const userData = app.getPath("userData");
  const dbPath = path.join(userData, "clipforge_local.db");
  const dbUrl = `sqlite:///${dbPath}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
    FRONTEND_URLS: `http://localhost:${port}`,
    ENABLE_YTDLP: "1",
    ENABLE_WEB_CLIPPER: "1",
    TRANSCRIPTION_PROVIDER: process.env.TRANSCRIPTION_PROVIDER ?? "assemblyai",
    PYTHONUNBUFFERED: "1",
  };

  const pythonBin = getPythonBin();

  // Prefer poetry if available and venv exists
  const usePoetry = fs.existsSync(path.join(backendDir, "poetry.lock")) && fs.existsSync(path.join(backendDir, ".venv"));
  const args = usePoetry
    ? ["run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"]
    : ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"];

  const cwd = backendDir;
  const cmd = usePoetry ? "poetry" : pythonBin;

  console.log(`[fastapi] spawning ${cmd} ${args.join(" ")} in ${cwd} db=${dbUrl}`);

  proc = spawn(cmd, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d) => console.log(`[fastapi] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d) => console.error(`[fastapi] ${d.toString().trim()}`));
  proc.on("exit", (code) => {
    console.log(`[fastapi] exit ${code}`);
    proc = null;
    apiUrl = null;
  });
  proc.on("error", (e) => console.error("[fastapi] spawn error", e));

  apiUrl = `http://127.0.0.1:${port}/api/v1`;
  // wait for health
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        console.log(`[fastapi] ready at ${apiUrl}`);
        // For sqlite (local), create tables via metadata (alembic has pg-only ALTERs)
        if (dbUrl.startsWith("sqlite")) {
          try {
            const { spawnSync } = await import("node:child_process");
            const createCmd = usePoetry ? "poetry" : pythonBin;
            const createArgs = usePoetry
              ? ["run", "python", "-c", "from app.models import Base; from app.database import get_engine; Base.metadata.create_all(bind=get_engine()); print('sqlite tables ok')"]
              : ["-c", "from app.models import Base; from app.database import get_engine; Base.metadata.create_all(bind=get_engine()); print('sqlite tables ok')"];
            const r = spawnSync(createCmd, createArgs, { cwd, env, stdio: "pipe", timeout: 15000 });
            console.log(`[fastapi] sqlite create_all: ${r.stdout?.toString().slice(0,200) ?? ""} ${r.stderr?.toString().slice(0,200) ?? ""}`);
          } catch (e) { console.error("[fastapi] sqlite create failed", e); }
        } else {
          try {
            const { spawnSync } = await import("node:child_process");
            const alembicBin = usePoetry ? "poetry" : pythonBin;
            const alembicArgs = usePoetry ? ["run", "alembic", "upgrade", "head"] : ["-m", "alembic", "upgrade", "head"];
            spawnSync(alembicBin, alembicArgs, { cwd, env, stdio: "ignore", timeout: 30000 });
          } catch {}
        }
        return apiUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("FastAPI failed to start");
}

export function getLocalApiUrl(): string | null {
  return apiUrl;
}

export function stopLocalFastAPI() {
  if (proc && !proc.killed) {
    try { proc.kill("SIGTERM"); } catch {}
    proc = null;
    apiUrl = null;
  }
}

export function isLocalFastAPIEnabled(): boolean {
  return process.env.USE_FASTAPI_LOCAL === "1" || process.env.ELECTRON_USE_FASTAPI === "1";
}
