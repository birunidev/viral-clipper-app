import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const { jobId, userDataPath, resourcesPath } = workerData as { jobId: string; userDataPath: string; resourcesPath: string };

process.env.USER_DATA_PATH = userDataPath;
process.env.RESOURCES_PATH = resourcesPath;

async function run() {
  console.log(`[worker] start jobId=${jobId} userData=${userDataPath} resources=${resourcesPath}`);
  try {

    console.log("[worker] importing pipeline");
    const { runAnalyze, runRender } = await import("../services/pipeline.js");
    const { getRaw } = await import("../services/db.js");
    console.log("[worker] imports ok");

    const job = getRaw().prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
    console.log(`[worker] job found`, job ? `${job.id} type=${job.type} status=${job.status}` : "null");
    if (!job) {
      parentPort?.postMessage({ type: "error", error: "Job not found" });
      return;
    }
    const type = (job.type as string) || "analyze";
    const onProgress = (stage: string, progress: number) => {
      console.log(`[worker] progress ${stage} ${progress}`);
      parentPort?.postMessage({ type: "progress", stage, progress });
    };
    if (type === "render") {
      console.log("[worker] runRender");
      await runRender(jobId, onProgress);
    } else {
      console.log("[worker] runAnalyze");
      await runAnalyze(jobId, onProgress);
    }
    console.log("[worker] done");
    parentPort?.postMessage({ type: "done" });
  } catch (e) {
    console.error("[worker] error", e);
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

run().catch((e) => console.error("[worker] run failed", e));
