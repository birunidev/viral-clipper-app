import { _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export const E2E_YT_ID = "p1t-074cn38";
export const E2E_YT_URL = `https://www.youtube.com/watch?v=${E2E_YT_ID}&pp=ugUEEgJpZA%3D%3D`;

export async function launchClipZard(opts: { userData?: string } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), "clipzard-e2e-"));
  // Ensure clean DB dir - models are shared at ~/.config/clipzard-desktop/models (symlink not needed, app will find via default)
  // Force prod license check to actually hit prod (bypass disabled when LICENSE_VERIFY_URL is prod)
  const app = await electron.launch({
    args: ["."],
    cwd: path.resolve("."),
    env: {
      ...process.env,
      ELECTRON_DEV_URL: process.env.ELECTRON_DEV_URL ?? "http://localhost:5173",
      USER_DATA_PATH: userData,
      LICENSE_ENFORCE: "1",
      LICENSE_VERIFY_URL: "https://clipzard.web.id/api/license/verify",
      // Use real AI - 1.5B balanced (950MB) already on disk, whisper base
      LLM_TIER: process.env.LLM_TIER ?? "balanced",
      WHISPER_MODEL: process.env.WHISPER_MODEL ?? "base",
      NODE_ENV: "production", // ensure not dev-bypass? electron's isDevBypass checks isPackaged false, but LICENSE_ENFORCE overrides
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState();
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
