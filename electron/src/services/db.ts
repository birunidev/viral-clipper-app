import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function getAppUserData(): string | null {
  if (process.env.USER_DATA_PATH) return process.env.USER_DATA_PATH;
  try { const { app } = require("electron") as { app: { getPath: (n: string) => string } }; return app.getPath("userData"); } catch { return null; }
}
let _db: any = null;
type Stmt = { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown };
function getDbPath(): string {
  const envPath = process.env.USER_DATA_PATH;
  if (envPath) { fs.mkdirSync(envPath, { recursive: true }); return path.join(envPath, "clipzard.db"); }
  const appPath = getAppUserData();
  const base = appPath ?? path.join(process.cwd(), ".data");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "clipzard.db");
}
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'youtube', source_key TEXT,
      language TEXT, status TEXT NOT NULL DEFAULT 'idle',
      storage_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'analyze', clip_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued', stage TEXT,
      progress INTEGER NOT NULL DEFAULT 0, error TEXT, options TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      job_id TEXT,
      title TEXT NOT NULL, viral_hook TEXT,
      start_time REAL NOT NULL, end_time REAL NOT NULL,
      video_url TEXT, thumbnail_url TEXT, caption_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timeline_words (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      idx INTEGER NOT NULL, text TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS caption_styles (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      config TEXT NOT NULL, is_builtin INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS license_cache (
      id TEXT PRIMARY KEY, license_key TEXT NOT NULL, email TEXT,
      valid INTEGER NOT NULL DEFAULT 0, verified_at TEXT, expires_at TEXT, payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
    CREATE INDEX IF NOT EXISTS idx_words_project ON timeline_words(project_id);
`;

// --- Electron sqlite-electron bridge (async, main process only) ---
let sqliteElectron: any = null;
let electronReady = false;
let electronReadyPromise: Promise<void> | null = null;

function isElectronMain(): boolean {
  return !!process.versions.electron && process.type === "browser";
}

async function ensureElectronDb(): Promise<void> {
  if (electronReady) return;
  if (electronReadyPromise) return electronReadyPromise;
  if (!isElectronMain()) return;
  electronReadyPromise = (async () => {
    try {
      const mod = require("sqlite-electron");
      sqliteElectron = mod;
      const p = getDbPath();
      await sqliteElectron.setdbPath(p);
      await sqliteElectron.executeScript(SCHEMA);
      electronReady = true;
      console.log("[db] sqlite-electron ready at", p);
      // Migrate JSON fallback if DB empty but JSON has data
      try {
        const jsonPath = p.replace(/\.db$/, ".json");
        if (fs.existsSync(jsonPath)) {
          const cnt = await sqliteElectron.fetchOne("SELECT count(*) as c FROM projects") as { c: number } | undefined;
          const c = (cnt as any)?.c ?? 0;
          if (c === 0) {
            const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
            if (raw.projects?.length || raw.jobs?.length) {
              console.log("[db] migrating JSON fallback to sqlite-electron", jsonPath);
              for (const tbl of ["projects","jobs","clips","timeline_words","caption_styles","license_cache"] as const) {
                for (const row of (raw[tbl] ?? []) as Record<string, unknown>[]) {
                  const cols = Object.keys(row);
                  const placeholders = cols.map(() => "?").join(",");
                  const vals = cols.map(k => {
                    const v = row[k];
                    return typeof v === "object" ? JSON.stringify(v) : v;
                  });
                  try { await sqliteElectron.executeQuery(`INSERT OR IGNORE INTO ${tbl} (${cols.join(",")}) VALUES (${placeholders})`, vals); } catch {}
                  // For JSON string columns like config, keep as string
                  try {
                    if (tbl==="caption_styles" && row.config && typeof row.config === "object") {
                      await sqliteElectron.executeQuery(`UPDATE caption_styles SET config=? WHERE id=?`, [JSON.stringify(row.config), row.id]);
                    }
                  } catch {}
                }
              }
            }
          }
        }
      } catch (e) { console.warn("[db] json migrate failed", e); }
    } catch (e) {
      console.warn("[db] sqlite-electron init failed, falling back to node:sqlite/json", String(e).slice(0,400));
      sqliteElectron = null;
    }
  })();
  return electronReadyPromise;
}

export async function initDb(): Promise<void> {
  if (isElectronMain()) {
    await ensureElectronDb();
    if (electronReady) return;
  }
  // non-electron or fallback: trigger sync init
  getDbInnerSync();
}

export function isSqliteElectron(): boolean { return electronReady && !!sqliteElectron; }

export async function dbFetchOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  if (isElectronMain() && sqliteElectron) {
    await ensureElectronDb();
    if (electronReady) return (await sqliteElectron.fetchOne(sql, params as any)) as T | undefined;
  }
  return getDbInnerSync().prepare(sql).get(...params) as T | undefined;
}
export async function dbFetchAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (isElectronMain() && sqliteElectron) {
    await ensureElectronDb();
    if (electronReady) return (await sqliteElectron.fetchAll(sql, params as any)) as T[];
  }
  return getDbInnerSync().prepare(sql).all(...params) as T[];
}
export async function dbExec(sql: string, params: unknown[] = []): Promise<void> {
  if (isElectronMain() && sqliteElectron) {
    await ensureElectronDb();
    if (electronReady) { await sqliteElectron.executeQuery(sql, params as any); return; }
  }
  getDbInnerSync().prepare(sql).run(...params);
}
export async function dbExecute(sql: string, params: unknown[] = []): Promise<void> { return dbExec(sql, params); }
export async function dbRun(sql: string, params: unknown[] = []): Promise<void> { return dbExec(sql, params); }
export async function dbScript(script: string): Promise<void> {
  if (isElectronMain() && sqliteElectron) {
    await ensureElectronDb();
    if (electronReady) { await sqliteElectron.executeScript(script); return; }
  }
  getDbInnerSync().exec(script);
}

// Keep sync API for CLI / utility (non-Electron) — deprecated for main
let _syncFallback: ReturnType<typeof createJsonFallback> | null = null;
function createJsonFallback(p: string) {
  const jsonPath = p.replace(/\.db$/, ".json");
  let data: Record<string, unknown[]> = {};
  const reload = () => { try { if (fs.existsSync(jsonPath)) { const fresh = JSON.parse(fs.readFileSync(jsonPath, "utf-8")); for (const t of ["projects","jobs","clips","timeline_words","caption_styles","license_cache"] as const) if (fresh[t]) data[t]=fresh[t] as unknown[]; } } catch {} };
  try { if (fs.existsSync(jsonPath)) data = JSON.parse(fs.readFileSync(jsonPath, "utf-8")); } catch { data={}; }
  const tables=["projects","jobs","clips","timeline_words","caption_styles","license_cache"]; for(const t of tables) if(!data[t]) data[t]=[];
  const persist=()=>{ try{ fs.writeFileSync(jsonPath, JSON.stringify(data,null,2)); }catch{} };
  const matchWhere=(rows:Record<string,unknown>[], sql:string, params:unknown[])=>{ const lower=sql.toLowerCase(); if(lower.includes("where deleted_at is not null")) return rows.filter(r=>!!(r as any).deleted_at); if(lower.includes("where deleted_at is null")) return rows.filter(r=>!(r as any).deleted_at); if(lower.includes("where id=?")||lower.includes("where id =?")) return rows.filter(r=>String(r.id)===String(params[0])); if(lower.includes("where project_id=?")||lower.includes("where project_id =?")) return rows.filter(r=>String((r as any).project_id)===String(params[0])); if(lower.includes("where project_id=? and clip_id=?")) return rows.filter(r=>String((r as any).project_id)===String(params[0])&&String((r as any).clip_id)===String(params[1])); return rows; };
  return {
    prepare(sql:string): Stmt {
      const lower=sql.trim().toLowerCase();
      return {
        get: (...params: unknown[])=>{ if(lower.startsWith("select")){ reload(); const m=sql.match(/from\s+(\w+)/i); const table=m?.[1]; if(!table||!data[table]) return undefined; let rows=data[table] as Record<string,unknown>[]; if(lower.includes("where")) rows=matchWhere(rows,sql,params); if(lower.includes("order by")){ if(lower.includes("updated_at desc")) rows=[...rows].sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))); if(lower.includes("start_time")) rows=[...rows].sort((a,b)=>Number(a.start_time)-Number(b.start_time)); if(lower.includes("idx")) rows=[...rows].sort((a,b)=>Number(a.idx)-Number(b.idx)); } return rows[0]; } return undefined; },
        all: (...params: unknown[])=>{ if(lower.startsWith("select")){ reload(); const m=sql.match(/from\s+(\w+)/i); const table=m?.[1]; if(!table||!data[table]) return []; let rows=data[table] as Record<string,unknown>[]; if(lower.includes("where")) rows=matchWhere(rows,sql,params); if(lower.includes("order by")){ if(lower.includes("updated_at desc")) rows=[...rows].sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))); if(lower.includes("start_time")) rows=[...rows].sort((a,b)=>Number(a.start_time)-Number(b.start_time)); if(lower.includes("idx")) rows=[...rows].sort((a,b)=>Number(a.idx)-Number(b.idx)); if(lower.includes("created_at desc")) rows=[...rows].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))); } return rows; } return []; },
        run: (...params: unknown[])=>{ reload(); if(lower.startsWith("insert")){ const m=sql.match(/into\s+(\w+)\s*\(([^)]+)\)/i); const table=m?.[1]; const cols=m?.[2].split(",").map(s=>s.trim()); if(table&&cols&&data[table]){ const row:Record<string,unknown>={}; cols.forEach((c,i)=>(row[c]=params[i])); if(lower.includes("or replace")){ const idx=(data[table] as Record<string,unknown>[]).findIndex(r=>String(r.id)===String(row.id)); if(idx>=0) (data[table] as Record<string,unknown>[])[idx]={...(data[table] as Record<string,unknown>[])[idx],...row}; else (data[table] as unknown[]).push(row); } else (data[table] as unknown[]).push(row); persist(); } return {}; } if(lower.startsWith("update")){ const m=sql.match(/update\s+(\w+)/i); const table=m?.[1]; if(table&&data[table]){ const lowerSql=sql.toLowerCase(); if(lowerSql.includes("set deleted_at=null")&&lowerSql.includes("where id=?")){ const updatedAt=params[0]; const idVal=params[1]; for(const r of data[table] as Record<string,unknown>[]) if(String(r.id)===String(idVal)){ r.deleted_at=null; (r as any).updated_at=updatedAt; } persist(); return {}; } if(lowerSql.includes("set deleted_at=?")&&lowerSql.includes("where id=?")){ const deletedAt=params[0]; const idVal=params[1]; for(const r of data[table] as Record<string,unknown>[]) if(String(r.id)===String(idVal)) r.deleted_at=deletedAt; persist(); return {}; } const setMatch=sql.match(/set\s+(.+?)\s+where/i); const whereMatch=sql.match(/where\s+(.+)/i); if(setMatch&&whereMatch){ const setParts=setMatch[1].split(",").map(s=>s.trim()); const setCols:string[]=[]; const setVals:unknown[]=[]; setParts.forEach(part=>{ const eqIdx=part.indexOf("="); const col=part.slice(0,eqIdx).trim(); const valRaw=part.slice(eqIdx+1).trim(); setCols.push(col); if(valRaw==="?") setVals.push("__PLACEHOLDER__"); else if(valRaw.toUpperCase()==="NULL") setVals.push(null); else if(/^'.*'$/.test(valRaw)||/^".*"$/.test(valRaw)) setVals.push(valRaw.slice(1,-1)); else if(!isNaN(Number(valRaw))) setVals.push(Number(valRaw)); else setVals.push(valRaw); }); const wherePart=whereMatch[1].trim().toLowerCase(); if(wherePart.includes("id=?")){ const idVal=params[params.length-1]; const valMap:Record<string,unknown>={}; let pIdx=0; setCols.forEach((c,i)=>{ if(setVals[i]==="__PLACEHOLDER__") valMap[c]=params[pIdx++]; else valMap[c]=setVals[i]; }); for(const r of data[table] as Record<string,unknown>[]) if(String(r.id)===String(idVal)) Object.assign(r,valMap); } persist(); } } return {}; } if(lower.startsWith("delete")){ const m=sql.match(/from\s+(\w+)/i); const table=m?.[1]; if(table&&data[table]){ if(lower.includes("where id=?")){ const idVal=params[0]; const before=(data[table] as unknown[]).length; data[table]=(data[table] as Record<string,unknown>[]).filter(r=>String(r.id)!==String(idVal)); if(table==="projects"&&(data[table] as unknown[]).length<before){ const pid=String(idVal); for(const t of ["clips","jobs","timeline_words"] as const) if(data[t]) data[t]=(data[t] as Record<string,unknown>[]).filter(r=>String(r.project_id)!==pid); } persist(); } else if(lower.includes("where project_id=?")){ data[table]=(data[table] as Record<string,unknown>[]).filter(r=>String(r.project_id)!==String(params[0])); persist(); } } return {}; } return {}; },
      };
    },
    exec: (_sql:string)=>{},
    transaction: <T extends () => void>(fn:T): T => { return (()=>{ fn(); persist(); }) as T; },
  };
}
function getDbInnerSync() {
  if (_db) return _db;
  const p = getDbPath();
  try {
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => { exec: (s:string)=>void; prepare: (s:string)=>{ get:(...a:unknown[])=>unknown; all:(...a:unknown[])=>unknown[]; run:(...a:unknown[])=>unknown } } };
    const db = new DatabaseSync(p);
    (db as any).exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    (db as any).exec(SCHEMA);
    const wrap = {
      prepare(sql:string): Stmt {
        const stmt=(db as any).prepare(sql);
        return { get: (...a:unknown[])=>stmt.get(...a), all: (...a:unknown[])=>stmt.all(...a), run: (...a:unknown[])=>stmt.run(...a), };
      },
      exec: (sql:string)=>(db as any).exec(sql),
      transaction: <T extends () => void>(fn:T): T => { return (()=>{ (db as any).exec("BEGIN"); try{ fn(); (db as any).exec("COMMIT"); }catch(e){ (db as any).exec("ROLLBACK"); throw e; } }) as T; },
    };
    _db=wrap; return _db;
  } catch {}
  if (!_syncFallback) _syncFallback=createJsonFallback(p);
  _db=_syncFallback; return _db;
}
export function getDb(): unknown { return getDbInnerSync(); }
export function getRaw() { return getDbInnerSync(); }
export function getDbPathExport(): string { return getDbPath(); }
export function nowIso(): string { return new Date().toISOString(); }
