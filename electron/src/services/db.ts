import path from "node:path";
import fs from "node:fs";
import { app } from "electron";

let _db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown }; exec: (s: string) => void; transaction: <T extends () => void>(fn: T) => T } | null = null;

type Stmt = { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown };

function getDbPath(): string {
  const base = app ? app.getPath("userData") : path.join(process.cwd(), ".data");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "clipforge.db");
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

let _syncFallback: ReturnType<typeof createJsonFallback> | null = null;

function createJsonFallback(p: string) {
  const jsonPath = p.replace(/\.db$/, ".json");
  let data: Record<string, unknown[]> = {};
  try {
    if (fs.existsSync(jsonPath)) data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  } catch { data = {}; }
  const tables = ["projects", "jobs", "clips", "timeline_words", "caption_styles", "license_cache"];
  for (const t of tables) if (!data[t]) data[t] = [];
  const persist = () => { try { fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2)); } catch {} };

  const matchWhere = (rows: Record<string, unknown>[], sql: string, params: unknown[]) => {
    // very limited parser for our known queries
    if (sql.includes("WHERE id=?") || sql.includes("WHERE id =?")) {
      return rows.filter((r) => String(r.id) === String(params[0]));
    }
    if (sql.includes("WHERE project_id=?") || sql.includes("WHERE project_id =?")) {
      return rows.filter((r) => String((r as Record<string, unknown>).project_id) === String(params[0]));
    }
    if (sql.includes("WHERE deleted_at IS NULL")) {
      return rows.filter((r) => !(r as Record<string, unknown>).deleted_at);
    }
    if (sql.includes("WHERE project_id=? AND clip_id=?")) {
      return rows.filter((r) => String((r as Record<string, unknown>).project_id) === String(params[0]) && String((r as Record<string, unknown>).clip_id) === String(params[1]));
    }
    return rows;
  };

  return {
    prepare(sql: string): Stmt {
      const lower = sql.trim().toLowerCase();
      return {
        get: (...params: unknown[]) => {
          if (lower.startsWith("select")) {
            const m = sql.match(/from\s+(\w+)/i);
            const table = m?.[1];
            if (!table || !data[table]) return undefined;
            let rows = data[table] as Record<string, unknown>[];
            if (lower.includes("where")) rows = matchWhere(rows, sql, params);
            if (lower.includes("order by")) {
              if (lower.includes("updated_at desc")) rows = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
              if (lower.includes("start_time")) rows = [...rows].sort((a, b) => Number(a.start_time) - Number(b.start_time));
              if (lower.includes("idx")) rows = [...rows].sort((a, b) => Number(a.idx) - Number(b.idx));
            }
            return rows[0];
          }
          return undefined;
        },
        all: (...params: unknown[]) => {
          if (lower.startsWith("select")) {
            const m = sql.match(/from\s+(\w+)/i);
            const table = m?.[1];
            if (!table || !data[table]) return [];
            let rows = data[table] as Record<string, unknown>[];
            if (lower.includes("where")) rows = matchWhere(rows, sql, params);
            if (lower.includes("order by")) {
              if (lower.includes("updated_at desc")) rows = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
              if (lower.includes("start_time")) rows = [...rows].sort((a, b) => Number(a.start_time) - Number(b.start_time));
              if (lower.includes("idx")) rows = [...rows].sort((a, b) => Number(a.idx) - Number(b.idx));
              if (lower.includes("created_at desc")) rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
            }
            return rows;
          }
          return [];
        },
        run: (...params: unknown[]) => {
          if (lower.startsWith("insert")) {
            const m = sql.match(/into\s+(\w+)\s*\(([^)]+)\)/i);
            const table = m?.[1];
            const cols = m?.[2].split(",").map((s) => s.trim());
            if (table && cols && data[table]) {
              const row: Record<string, unknown> = {};
              cols.forEach((c, i) => (row[c] = params[i]));
              // handle INSERT OR REPLACE
              if (lower.includes("or replace")) {
                const idx = (data[table] as Record<string, unknown>[]).findIndex((r) => String(r.id) === String(row.id));
                if (idx >= 0) (data[table] as Record<string, unknown>[])[idx] = { ...(data[table] as Record<string, unknown>[])[idx], ...row };
                else (data[table] as unknown[]).push(row);
              } else {
                (data[table] as unknown[]).push(row);
              }
              persist();
            }
            return {};
          }
          if (lower.startsWith("update")) {
            const m = sql.match(/update\s+(\w+)/i);
            const table = m?.[1];
            if (table && data[table]) {
              // parse SET col=? and WHERE id=?
              const setMatch = sql.match(/set\s+(.+?)\s+where/i);
              const whereMatch = sql.match(/where\s+(.+)/i);
              if (setMatch && whereMatch) {
                const setCols = setMatch[1].split(",").map((s) => s.trim().split("=")[0].trim());
                const wherePart = whereMatch[1].trim();
                let targetRows: Record<string, unknown>[] = data[table] as Record<string, unknown>[];
                if (wherePart.includes("id=?")) {
                  const idVal = params[setCols.length];
                  targetRows = targetRows.filter((r) => String(r.id) === String(idVal));
                  const valMap: Record<string, unknown> = {};
                  setCols.forEach((c, i) => (valMap[c] = params[i]));
                  for (const r of data[table] as Record<string, unknown>[]) {
                    if (String(r.id) === String(idVal)) Object.assign(r, valMap);
                  }
                } else if (wherePart.includes("project_id=?") && wherePart.includes("clip_id=?")) {
                  // not used for update
                } else if (wherePart.includes("project_id=?")) {
                  const pid = params[setCols.length];
                  for (const r of data[table] as Record<string, unknown>[]) {
                    if (String(r.project_id) === String(pid)) Object.assign(r, Object.fromEntries(setCols.map((c, i) => [c, params[i]])));
                  }
                }
                persist();
              }
            }
            return {};
          }
          if (lower.startsWith("delete")) {
            const m = sql.match(/from\s+(\w+)/i);
            const table = m?.[1];
            if (table && data[table] && lower.includes("where project_id=?")) {
              data[table] = (data[table] as Record<string, unknown>[]).filter((r) => String(r.project_id) !== String(params[0]));
              persist();
            }
            return {};
          }
          return {};
        },
      };
    },
    exec: (_sql: string) => {},
    transaction: <T extends () => void>(fn: T): T => {
      return (() => { fn(); persist(); }) as T;
    },
  };
}

function getDbInnerSync() {
  if (_db) return _db;
  const p = getDbPath();
  // Try node:sqlite first (Node 24), fallback to JSON
  try {
    const { DatabaseSync } = eval("require")("node:sqlite") as { DatabaseSync: new (p: string) => { exec: (s: string) => void; prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } } };
    const db = new DatabaseSync(p);
    (db as unknown as { exec: (s: string) => void }).exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    (db as unknown as { exec: (s: string) => void }).exec(SCHEMA);
    const wrap = {
      prepare(sql: string): Stmt {
        const stmt = (db as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } }).prepare(sql);
        return {
          get: (...a: unknown[]) => stmt.get(...a),
          all: (...a: unknown[]) => stmt.all(...a),
          run: (...a: unknown[]) => stmt.run(...a),
        };
      },
      exec: (sql: string) => (db as unknown as { exec: (s: string) => void }).exec(sql),
      transaction: <T extends () => void>(fn: T): T => {
        return (() => {
          (db as unknown as { exec: (s: string) => void }).exec("BEGIN");
          try { fn(); (db as unknown as { exec: (s: string) => void }).exec("COMMIT"); } catch (e) { (db as unknown as { exec: (s: string) => void }).exec("ROLLBACK"); throw e; }
        }) as T;
      },
    };
    _db = wrap;
    return _db;
  } catch {}
  if (!_syncFallback) _syncFallback = createJsonFallback(p);
  _db = _syncFallback;
  return _db;
}

export function getDb(): unknown { return getDbInnerSync(); }
export function getRaw() { return getDbInnerSync(); }
export function getDbPathExport(): string { return getDbPath(); }
export function nowIso(): string { return new Date().toISOString(); }
