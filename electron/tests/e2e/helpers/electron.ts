import { _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export const E2E_YT_ID = "p1t-074cn38";
export const E2E_YT_URL = `https://www.youtube.com/watch?v=${E2E_YT_ID}&pp=ugUEEgJpZA%3D%3D`;

export async function launchClipZard(opts: { userData?: string } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), "clipzard-e2e-"));
  // Wait for Vite dev server to be ready before launching Electron
  const viteUrl = process.env.ELECTRON_DEV_URL ?? "http://localhost:5173";
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(viteUrl);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const app = await electron.launch({
    args: ["."],
    cwd: path.resolve("."),
    env: {
      ...process.env,
      ELECTRON_DEV_URL: viteUrl,
      USER_DATA_PATH: userData,
      LICENSE_ENFORCE: "1",
      LICENSE_VERIFY_URL: "https://clipzard.web.id/api/license/verify",
      LLM_TIER: process.env.LLM_TIER ?? "balanced",
      WHISPER_MODEL: process.env.WHISPER_MODEL ?? "base",
      NODE_ENV: "production",
    },
  });
  // DevTools is opened detached in dev (main.ts:41), so firstWindow may be DevTools, not the app
  let page: Page | null = null;
  for (let i = 0; i < 15; i++) {
    const wins = app.windows();
    for (const w of wins) {
      const url = w.url();
      if (url.includes("localhost:5173") || url.includes("clipzard") || url.includes("file://")) {
        if (!url.startsWith("devtools://")) {
          page = w;
          break;
        }
      }
    }
    if (page) break;
    // Also try firstWindow as fallback if it is not devtools
    const fw = await app.firstWindow().catch(() => null);
    if (fw) {
      const url = fw.url();
      if (!url.startsWith("devtools://")) {
        page = fw;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) page = await app.firstWindow();
  console.log(`[e2e] using page url=${page.url()}`);
  page.on("console", (msg) => console.log(`[e2e console:${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[e2e pageerror] ${err}`));
  page.on("requestfailed", (req) => console.log(`[e2e requestfailed] ${req.url()} ${req.failure()?.errorText}`));
  // Vite HMR may need a moment to inject the app
  for (let i = 0; i < 30; i++) {
    const hasContent = await page.evaluate(() => document.querySelector("#root")?.children.length ?? 0).catch(() => 0);
    if (hasContent > 0) {
      console.log(`[e2e] #root has ${hasContent} children`);
      break;
    }
    if (i % 5 === 0) console.log(`[e2e] waiting for #root children, try ${i}, url=${page.url()}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  return { app, page, userData };
}

export async function waitForProjectStatus(page: Page, expected: string, timeout = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const pill = page.locator('[data-testid="status-pill"], . StatusPill, [class*="StatusPill"]').first();
    // fallback: look for text
    const body = await page.textContent("body").catch(() => "");
    if (body?.toLowerCase().includes(expected.toLowerCase())) return;
    await page.waitForTimeout(2000);
  }
  throw new Error(`timeout waiting for project status ${expected}`);
}

export async function getClipsCount(page: Page): Promise<number> {
  // ClipCard grid - count cards with "Download" or "Save to"
  const cards = page.locator('text="Save to" , text="Download" , text="Render for download"').first();
  await page.waitForTimeout(500);
  const clipsHeader = page.locator('text=/\\d+ found/').first();
  const txt = await clipsHeader.textContent().catch(() => null);
  if (txt) {
    const m = txt.match(/(\d+)\s+found/);
    if (m) return parseInt(m[1], 10);
  }
  // fallback count cards
  const count = await page.locator('[class*="group flex flex-col overflow-hidden"]').count().catch(() => 0);
  return count;
}
