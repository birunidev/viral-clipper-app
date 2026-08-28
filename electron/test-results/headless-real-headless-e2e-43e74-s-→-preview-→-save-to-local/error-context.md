# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: headless-real.spec.ts >> headless e2e — real youtube short → viral moments → preview → save to local
- Location: tests/e2e/headless-real.spec.ts:10:1

# Error details

```
Error: page.goto: Target page, context or browser has been closed
Call log:
  - navigating to "http://localhost:5173/#/", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect } from "@playwright/test";
  2   | import { launchClipZard, E2E_YT_URL } from "./helpers/electron";
  3   | import path from "node:path";
  4   | import fs from "node:fs";
  5   | import os from "node:os";
  6   | 
  7   | // Headless, real AI, real YouTube (short ~1-2 min) — as requested.
  8   | test.setTimeout(420_000);
  9   | 
  10  | test("headless e2e — real youtube short → viral moments → preview → save to local", async () => {
  11  |   const userData = fs.mkdtempSync(path.join(os.tmpdir(), "clipzard-e2e-"));
  12  |   console.log(`[e2e] USER_DATA_PATH=${userData} YT=${E2E_YT_URL}`);
  13  | 
  14  |   const { app, page } = await launchClipZard({ userData });
  15  | 
  16  |   // Handle native save dialog: stub to tmp/out.mp4
  17  |   const saveDest = path.join(userData, "e2e-out.mp4");
  18  |   await app.evaluate(async ({ dialog }, dest) => {
  19  |     // Stub dialog.showSaveDialog to return dest without UI (headless)
  20  |     // This runs in main process — patch via global
  21  |     const orig = dialog.showSaveDialog;
  22  |     // @ts-ignore
  23  |     dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest });
  24  |   }, saveDest).catch(() => {});
  25  | 
  26  |   try {
  27  |     // 1) Dashboard — create project (YouTube, no auto-start)
  28  |     await page.waitForTimeout(1500);
  29  |     // App may start at /login if not licensed — activate if needed
  30  |     const needsLogin = await page.locator('text="Activate ClipZard"').isVisible().catch(() => false);
  31  |     if (needsLogin) {
  32  |       console.log("[e2e] activating with CF-TEST-0001-UNLIMITED");
  33  |       await page.fill('input[placeholder="CF-XXXX-XXXX-XXXX"]', "CF-TEST-0001-UNLIMITED");
  34  |       await page.click('button:has-text("Activate")');
  35  |       await page.waitForTimeout(1500);
  36  |     }
  37  | 
  38  |     // Ensure on Dashboard
> 39  |     await page.goto("http://localhost:5173/#/");
      |                ^ Error: page.goto: Target page, context or browser has been closed
  40  |     await expect(page.locator('text="Projects"')).toBeVisible({ timeout: 10_000 });
  41  | 
  42  |     // Open composer -> YouTube
  43  |     await page.click('button:has-text("New project")');
  44  |     // Already youtube by default, but ensure
  45  |     await page.click('button:has-text("YouTube link")').catch(() => {});
  46  |     await page.fill('input[placeholder="https://www.youtube.com/watch?v=..."]', E2E_YT_URL);
  47  |     await page.fill('input[placeholder="My podcast episode"]', "E2E Headless Short");
  48  |     await page.click('button:has-text("Create project")');
  49  | 
  50  |     // Should navigate to /projects/:id
  51  |     await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
  52  |     const projectUrl = page.url();
  53  |     const projectId = projectUrl.split("/projects/")[1]?.split("#")[0]?.split("?")[0] ?? "unknown";
  54  |     console.log(`[e2e] project ${projectId} created, url=${projectUrl}`);
  55  | 
  56  |     // Verify idle (not auto-started) — Find viral moments button visible
  57  |     await expect(page.locator('button:has-text("Find viral moments")')).toBeVisible({ timeout: 10_000 });
  58  | 
  59  |     // 2) Pick options and trigger pipeline
  60  |     // Defaults are portrait, 10, 15-90 — keep for short video (or tighter 5-30)
  61  |     await page.selectOption('select >> nth=0', 'portrait').catch(() => {});
  62  |     // Keep max 10 is fine for short
  63  |     await page.click('button:has-text("Find viral moments")');
  64  | 
  65  |     // Wait for pipeline stages
  66  |     console.log("[e2e] pipeline started — waiting for completed (up to 4 min for real whisper+1.5B)...");
  67  |     await expect(page.locator('text="Downloading source" , text="Transcribing audio" , text="Finding viral moments" , text="Working"').first()).toBeVisible({ timeout: 30_000 });
  68  | 
  69  |     // Poll for Clips header "X found" where X >0
  70  |     let clipsFound = 0;
  71  |     const pollStart = Date.now();
  72  |     while (Date.now() - pollStart < 240_000) {
  73  |       const header = await page.locator('text=/\\d+ found/').first().textContent().catch(() => null);
  74  |       if (header) {
  75  |         const m = header.match(/(\d+)\s+found/);
  76  |         if (m && parseInt(m[1], 10) > 0) { clipsFound = parseInt(m[1], 10); break; }
  77  |       }
  78  |       // Check for failed
  79  |       const failed = await page.locator('text="failed"').first().isVisible().catch(() => false);
  80  |       if (failed) {
  81  |         const err = await page.locator('[class*="danger"]').first().textContent().catch(() => "unknown");
  82  |         throw new Error(`pipeline failed: ${err}`);
  83  |       }
  84  |       await page.waitForTimeout(5000);
  85  |     }
  86  |     console.log(`[e2e] clipsFound=${clipsFound}`);
  87  |     expect(clipsFound).toBeGreaterThan(0);
  88  | 
  89  |     // 3) Preview first clip — check media:// sources and overlay
  90  |     const firstClipCard = page.locator('[class*="group flex flex-col overflow-hidden"]').first();
  91  |     await expect(firstClipCard).toBeVisible({ timeout: 10_000 });
  92  |     // Click thumbnail to open SeekPreview
  93  |     await firstClipCard.locator('button[aria-label^="Preview"]').click().catch(async () => {
  94  |       await firstClipCard.click();
  95  |     });
  96  |     await expect(page.locator('role=dialog')).toBeVisible({ timeout: 10_000 });
  97  |     // Check video src is media://
  98  |     const videoSrc = await page.locator('role=dialog video').getAttribute('src').catch(() => null);
  99  |     console.log(`[e2e] preview video src=${videoSrc?.slice(0,120)}`);
  100 |     expect(videoSrc ?? "").toMatch(/media:\/\//);
  101 |     // Close preview
  102 |     await page.keyboard.press("Escape").catch(() => {});
  103 |     await page.locator('button[aria-label="Close preview"]').click().catch(() => {});
  104 |     await expect(page.locator('role=dialog')).toBeHidden({ timeout: 5_000 }).catch(() => {});
  105 | 
  106 |     // 4) Caption style sanity — open picker and ensure built-ins exist
  107 |     // Click "Change captions" or "Render for download"
  108 |     const captionsBtn = page.locator('button:has-text("Change captions"), button:has-text("Render for download")').first();
  109 |     await expect(captionsBtn).toBeVisible();
  110 |     await captionsBtn.click();
  111 |     await expect(page.locator('text="Classic" , text="Clean"')).first().toBeVisible({ timeout: 5_000 }).catch(() => {});
  112 |     // Close picker
  113 |     await page.keyboard.press("Escape").catch(() => {});
  114 | 
  115 |     // 5) Render first clip → Save to local file
  116 |     // Stub already set for dialog:saveVideo to saveDest
  117 |     // Click first clip's Render (with no style -> null)
  118 |     const renderBtn = page.locator('button:has-text("Change captions")').first();
  119 |     // If Download already visible (already rendered in previous run), use Download Save to...
  120 |     const downloadBtn = page.locator('button:has-text("Save to")').first();
  121 |     const hasDownload = await downloadBtn.isVisible().catch(() => false);
  122 |     if (hasDownload) {
  123 |       console.log("[e2e] clip already rendered, testing Save to...");
  124 |       await downloadBtn.click();
  125 |       // saveDest should now exist (copied via dialog:saveVideo)
  126 |       await page.waitForTimeout(1500);
  127 |     } else {
  128 |       // Need to open picker and pick a style to render
  129 |       await page.click('button:has-text("Change captions")');
  130 |       // Click Classic
  131 |       await page.click('text="Classic"');
  132 |       console.log("[e2e] rendering with Classic style...");
  133 |       // Wait for rendering indicator
  134 |       await expect(page.locator('text="Rendering"')).toBeVisible({ timeout: 60_000 });
  135 |       // Wait for completion -> Download button appears
  136 |       await expect(page.locator('button:has-text("Save to")')).toBeVisible({ timeout: 180_000 });
  137 |       console.log("[e2e] render completed, now Save to...");
  138 |       await page.click('button:has-text("Save to")');
  139 |       await page.waitForTimeout(1500);
```