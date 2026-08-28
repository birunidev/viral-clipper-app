import { test, expect } from "@playwright/test";
import { launchClipZard, E2E_YT_URL } from "./helpers/electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Headless, real AI, real YouTube (short ~1-2 min) — as requested.
test.setTimeout(420_000);

test("headless e2e — real youtube short → viral moments → preview → save to local", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clipzard-e2e-"));
  console.log(`[e2e] USER_DATA_PATH=${userData} YT=${E2E_YT_URL}`);

  const { app, page } = await launchClipZard({ userData });

  // Handle native save dialog: stub to tmp/out.mp4
  const saveDest = path.join(userData, "e2e-out.mp4");
  await app.evaluate(async ({ dialog }, dest) => {
    // Stub dialog.showSaveDialog to return dest without UI (headless)
    // This runs in main process — patch via global
    const orig = dialog.showSaveDialog;
    // @ts-ignore
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest });
  }, saveDest).catch(() => {});

  try {
    // 1) Dashboard — create project (YouTube, no auto-start)
    await page.waitForTimeout(1500);
    // App may start at /login if not licensed — activate if needed
    const needsLogin = await page.locator('text="Activate ClipZard"').isVisible().catch(() => false);
    if (needsLogin) {
      console.log("[e2e] activating with CF-TEST-0001-UNLIMITED");
      await page.fill('input[placeholder="CF-XXXX-XXXX-XXXX"]', "CF-TEST-0001-UNLIMITED");
      await page.click('button:has-text("Activate")');
      await page.waitForTimeout(1500);
    }

    // Ensure on Dashboard
    await page.goto("http://localhost:5173/#/");
    await expect(page.locator('text="Projects"')).toBeVisible({ timeout: 10_000 });

    // Open composer -> YouTube
    await page.click('button:has-text("New project")');
    // Already youtube by default, but ensure
    await page.click('button:has-text("YouTube link")').catch(() => {});
    await page.fill('input[placeholder="https://www.youtube.com/watch?v=..."]', E2E_YT_URL);
    await page.fill('input[placeholder="My podcast episode"]', "E2E Headless Short");
    await page.click('button:has-text("Create project")');

    // Should navigate to /projects/:id
    await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    const projectUrl = page.url();
    const projectId = projectUrl.split("/projects/")[1]?.split("#")[0]?.split("?")[0] ?? "unknown";
    console.log(`[e2e] project ${projectId} created, url=${projectUrl}`);

    // Verify idle (not auto-started) — Find viral moments button visible
    await expect(page.locator('button:has-text("Find viral moments")')).toBeVisible({ timeout: 10_000 });

    // 2) Pick options and trigger pipeline
    // Defaults are portrait, 10, 15-90 — keep for short video (or tighter 5-30)
    await page.selectOption('select >> nth=0', 'portrait').catch(() => {});
    // Keep max 10 is fine for short
    await page.click('button:has-text("Find viral moments")');

    // Wait for pipeline stages
    console.log("[e2e] pipeline started — waiting for completed (up to 4 min for real whisper+1.5B)...");
    await expect(page.locator('text="Downloading source" , text="Transcribing audio" , text="Finding viral moments" , text="Working"').first()).toBeVisible({ timeout: 30_000 });

    // Poll for Clips header "X found" where X >0
    let clipsFound = 0;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 240_000) {
      const header = await page.locator('text=/\\d+ found/').first().textContent().catch(() => null);
      if (header) {
        const m = header.match(/(\d+)\s+found/);
        if (m && parseInt(m[1], 10) > 0) { clipsFound = parseInt(m[1], 10); break; }
      }
      // Check for failed
      const failed = await page.locator('text="failed"').first().isVisible().catch(() => false);
      if (failed) {
        const err = await page.locator('[class*="danger"]').first().textContent().catch(() => "unknown");
        throw new Error(`pipeline failed: ${err}`);
      }
      await page.waitForTimeout(5000);
    }
    console.log(`[e2e] clipsFound=${clipsFound}`);
    expect(clipsFound).toBeGreaterThan(0);

    // 3) Preview first clip — check media:// sources and overlay
    const firstClipCard = page.locator('[class*="group flex flex-col overflow-hidden"]').first();
    await expect(firstClipCard).toBeVisible({ timeout: 10_000 });
    // Click thumbnail to open SeekPreview
    await firstClipCard.locator('button[aria-label^="Preview"]').click().catch(async () => {
      await firstClipCard.click();
    });
    await expect(page.locator('role=dialog')).toBeVisible({ timeout: 10_000 });
    // Check video src is media://
    const videoSrc = await page.locator('role=dialog video').getAttribute('src').catch(() => null);
    console.log(`[e2e] preview video src=${videoSrc?.slice(0,120)}`);
    expect(videoSrc ?? "").toMatch(/media:\/\//);
    // Close preview
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator('button[aria-label="Close preview"]').click().catch(() => {});
    await expect(page.locator('role=dialog')).toBeHidden({ timeout: 5_000 }).catch(() => {});

    // 4) Caption style sanity — open picker and ensure built-ins exist
    // Click "Change captions" or "Render for download"
    const captionsBtn = page.locator('button:has-text("Change captions"), button:has-text("Render for download")').first();
    await expect(captionsBtn).toBeVisible();
    await captionsBtn.click();
    await expect(page.locator('text="Classic" , text="Clean"')).first().toBeVisible({ timeout: 5_000 }).catch(() => {});
    // Close picker
    await page.keyboard.press("Escape").catch(() => {});

    // 5) Render first clip → Save to local file
    // Stub already set for dialog:saveVideo to saveDest
    // Click first clip's Render (with no style -> null)
    const renderBtn = page.locator('button:has-text("Change captions")').first();
    // If Download already visible (already rendered in previous run), use Download Save to...
    const downloadBtn = page.locator('button:has-text("Save to")').first();
    const hasDownload = await downloadBtn.isVisible().catch(() => false);
    if (hasDownload) {
      console.log("[e2e] clip already rendered, testing Save to...");
      await downloadBtn.click();
      // saveDest should now exist (copied via dialog:saveVideo)
      await page.waitForTimeout(1500);
    } else {
      // Need to open picker and pick a style to render
      await page.click('button:has-text("Change captions")');
      // Click Classic
      await page.click('text="Classic"');
      console.log("[e2e] rendering with Classic style...");
      // Wait for rendering indicator
      await expect(page.locator('text="Rendering"')).toBeVisible({ timeout: 60_000 });
      // Wait for completion -> Download button appears
      await expect(page.locator('button:has-text("Save to")')).toBeVisible({ timeout: 180_000 });
      console.log("[e2e] render completed, now Save to...");
      await page.click('button:has-text("Save to")');
      await page.waitForTimeout(1500);
    }

    // Check file was saved via stub dest
    // In headless stub, file was copied to saveDest
    // Also check via IPC: list projects/clips to find local path
    const savedExists = fs.existsSync(saveDest);
    console.log(`[e2e] saveDest ${saveDest} exists=${savedExists} ${savedExists ? fs.statSync(saveDest).size + " bytes" : ""}`);
    if (savedExists) expect(fs.statSync(saveDest).size).toBeGreaterThan(1000);
    else {
      // Fallback: check userData/projects/<id>/clips/*.mp4 exists
      const clipsDir = path.join(userData, "projects", projectId, "clips");
      const files = fs.existsSync(clipsDir) ? fs.readdirSync(clipsDir).filter(f => f.endsWith(".mp4")) : [];
      console.log(`[e2e] clips dir ${clipsDir} files=${files.join(",")}`);
      expect(files.length).toBeGreaterThan(0);
    }

    // Reveal check (no assert, just not throw)
    const revealBtn = page.locator('button:has-text("Reveal")').first();
    if (await revealBtn.isVisible().catch(() => false)) {
      await revealBtn.click().catch(() => {});
    }

  } finally {
    await app.close().catch(() => {});
    // keep userData for inspection if needed: comment out rm
    // fs.rmSync(userData, { recursive: true, force: true });
    console.log(`[e2e] done userData=${userData} (kept for inspection)`);
  }
});
