import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const { jobId, userDataPath, resourcesPath } = workerData as { jobId: string; userDataPath: string; resourcesPath: string };

process.env.USER_DATA_PATH = userDataPath;
process.env.RESOURCES_PATH = resourcesPath;
(process as unknown as { resourcesPath: string }).resourcesPath = resourcesPath;

async function run() {
  try {
    // Set resourcesPath for bin resolution
    (process as unknown as { resourcesPath: string }).resourcesPath = resourcesPath;
    // @ts-ignore
    (global as unknown as { process: { resourcesPath: string } }).process = { resourcesPath } as unknown as NodeJS.Process;

    const { runAnalyze, runRender } = await import("../services/pipeline.js");
    const { getRaw } = await import("../services/db.js");

    // Need to ensure db uses correct path - it will use app.getPath mocked
    const job = getRaw().prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
    if (!job) {
      parentPort?.postMessage({ type: "error", error: "Job not found" });
      return;
    }
    const type = (job.type as string) || "analyze";
    const onProgress = (stage: string, progress: number) => {
      parentPort?.postMessage({ type: "progress", stage, progress });
    };
    if (type === "render") {
      await runRender(jobId, onProgress);
    } else {
      await runAnalyze(jobId, onProgress);
    }
    parentPort?.postMessage({ type: "done" });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    parentPort?.postMessage({ type: "error", error: msg });
    try {
      const { getRaw } = await import("../services/db.js");
      const db = getRaw();
      db.prepare("UPDATE jobs SET status='failed', error=? WHERE id=?").run(msg.slice(0, 500), jobId);
      const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
      if (job) db.prepare("UPDATE projects SET status='failed' WHERE id=?").run(job.project_id as string);
    } catch {}
  }
}

run();
