#!/usr/bin/env node
// verify-models.mjs — tests new LLM variant wiring without launching Electron window.
// Checks: system tier → llmModelForTier, variant helpers, models service disk state.
// Run: node electron/scripts/verify-models.mjs
//      LLM_TIER=tiny node electron/scripts/verify-models.mjs
//      USER_DATA_PATH=/tmp/cf-test node electron/scripts/verify-models.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
console.log(`[models-verify] node ${process.version} root=${root}`);
console.log(`[models-verify] USER_DATA_PATH=${process.env.USER_DATA_PATH ?? "(default ~/.config/clipzard-desktop)"} LLM_TIER=${process.env.LLM_TIER ?? "(auto)"}`);

let ok=0, fail=0;
const check = (label, fn) => {
  try { const v = fn(); console.log(`  ✓ ${label}${v ? ` → ${typeof v==='string'?v:JSON.stringify(v).slice(0,200)}`:""}`); ok++; }
  catch(e){ console.error(`  ✗ ${label}: ${e.message}`); if(e.stack) console.error(e.stack.slice(0,500)); fail++; }
};

const { ramTier, llmModelForTier, llmModelForVariant, whisperModelForTier } = await import(pathToFileURL(path.join(root, "dist/services/system.js")).href);
const { listVariants, currentSelectedVariant, whisperStatus, getVariantInfo } = await import(pathToFileURL(path.join(root, "dist/services/models.js")).href);

check("ramTier() in low|mid|high", () => {
  const t = ramTier();
  if(!["low","mid","high"].includes(t)) throw new Error(`bad tier ${t}`);
  return t;
});

check("llmModelForTier(low) is 1.5B default (950 MB) — was 3B before", () => {
  const m = llmModelForTier("low");
  if(!m.file.includes("1.5b")) throw new Error(`expected 1.5b, got ${m.file}`);
  if(!m.url.includes("bartowski")) throw new Error(`expected bartowski, got ${m.url}`);
  return `${m.file} ${m.url.slice(0,60)}`;
});

check("LLM_TIER=tiny override → 0.5B", async () => {
  process.env.LLM_TIER="tiny";
  // re-import fresh? system caches env at call time, so just call again
  const m = llmModelForTier("low");
  delete process.env.LLM_TIER;
  if(!m.file.includes("0.5b")) throw new Error(`tiny override failed: ${m.file}`);
  return m.file;
});

check("llmModelForVariant('tiny') 380 MB", () => {
  const v = llmModelForVariant("tiny");
  if(v.sizeMb!==380) throw new Error(`size ${v.sizeMb}`);
  return v.file;
});
check("llmModelForVariant('balanced') 950 MB", () => {
  const v = llmModelForVariant("balanced");
  if(v.sizeMb!==950) throw new Error(`size ${v.sizeMb}`);
  return v.file;
});
check("llmModelForVariant('quality') 2000 MB", () => {
  const v = llmModelForVariant("quality");
  if(v.sizeMb!==2000) throw new Error(`size ${v.sizeMb}`);
  return v.file;
});

check("listVariants() 3 entries with disk state", () => {
  const list = listVariants();
  if(list.length!==3) throw new Error(`len ${list.length}`);
  for(const v of list) if(!["tiny","balanced","quality"].includes(v.key)) throw new Error(`bad key ${v.key}`);
  return `${list.map(v=>`${v.key}:${v.installed?"installed":"not"}(${v.sizeMb}MB)`).join(" ")}`;
});

check("currentSelectedVariant() defaults to balanced (not tiny)", () => {
  const s = currentSelectedVariant();
  if(s!=="balanced") throw new Error(`expected balanced, got ${s} — set LLM_TIER explicitly if you want tiny`);
  return s;
});

check("whisperStatus() base/small/medium + path", () => {
  const w = whisperStatus();
  if(!w.model) throw new Error("no whisper model");
  return `${w.model} ${w.installed?"installed":"not"} ${w.path}`;
});

check("whisperModelForTier(low)=base", () => {
  const w = whisperModelForTier("low");
  if(w!=="base") throw new Error(w);
  return w;
});

console.log(`\n[models-verify] done ok=${ok} fail=${fail}`);
console.log(`[models-verify] Next:`);
console.log(`  1) CLI download: npm run models:download                 # 1.5B balanced`);
console.log(`  2) Tiny:         LLM_TIER=tiny npm run models:download  # 0.5B 380MB`);
console.log(`  3) Electron UI:  npm run dev → Settings → Local AI Models → Download/Use/Remove`);
console.log(`  4) Full pipe:    node electron/scripts/verify-pipeline.mjs --keep`);
if(fail) process.exitCode=1;
