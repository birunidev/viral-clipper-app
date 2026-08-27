#!/usr/bin/env python3
import os, time, json, random, pathlib, requests, sys

BASE = "http://localhost:8000/api/v1"
COOKIE = "/tmp/ck_test.jar"
# reuse existing session via cookies from file? simpler: login again
EMAIL = "reels-bot2@example.com"
PASSWORD = "Test12345!"

session = requests.Session()

def login():
    r = session.post(f"{BASE}/auth/login", json={"email": EMAIL, "password": PASSWORD})
    r.raise_for_status()
    print("[login]", r.json().get("email"))

login()

# Existing project IDs from previous run
PROJECTS = [
    ("9c70c5ec87cd4b1b93ff07ae9af5936d", "https://www.youtube.com/watch?v=Xx_3CPPTUms"),
    ("94bfc02d0c2040e2911d0b77ab919057", "https://www.youtube.com/watch?v=I7A_KFK4LXw"),
    ("5a6c2482eb76479185aa779a638db6f5", "https://www.youtube.com/watch?v=JgiCbH8Sy9g"),
    ("dbee091539d34286a0a7c8522b6fd339", "https://www.youtube.com/watch?v=FISRSdYerSA"),
]

def poll_job(job_id, timeout=1500):
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = session.get(f"{BASE}/jobs/{job_id}", timeout=30)
            r.raise_for_status()
            j = r.json()
            status = j.get("status")
            stage = j.get("stage")
            progress = j.get("progress")
            print(f"  [poll {job_id[:8]}] {status} {stage} {progress} err={j.get('error') and j.get('error')[:120]}")
            if status in ("completed", "failed"):
                return j
        except requests.exceptions.ConnectionError as e:
            print(f"  [poll] connection error {e}, retry in 5s")
        except Exception as e:
            print(f"  [poll] error {e}, retry")
        time.sleep(5)
    raise TimeoutError(f"job {job_id} timeout")

def get_project(pid):
    r = session.get(f"{BASE}/projects/{pid}")
    r.raise_for_status()
    return r.json()

# Poll each project's latest job - use known job IDs (hardcoded from creation)
JOB_MAP = {
    "9c70c5ec87cd4b1b93ff07ae9af5936d": "c98d945e43c64115882bfcfdcf3b5c98",
    "94bfc02d0c2040e2911d0b77ab919057": "705cbc85659c467a8a22551e0cf4b494",
    "5a6c2482eb76479185aa779a638db6f5": "b870bdda38d84689b2652e909b31ed87",
    "dbee091539d34286a0a7c8522b6fd339": "ce7b3b11572c4240aff84ff435bbeecb",
}
def poll_all(job_ids, timeout=1800):
    start = time.time()
    pending = set(job_ids)
    while pending and time.time() - start < timeout:
        for jid in list(pending):
            try:
                r = session.get(f"{BASE}/jobs/{jid}", timeout=30)
                r.raise_for_status()
                j = r.json()
                status = j.get("status")
                stage = j.get("stage")
                progress = j.get("progress")
                print(f"  [poll {jid[:8]}] {status} {stage} {progress}")
                if status in ("completed", "failed"):
                    if status == "completed":
                        print(f"  ✓ {jid[:8]} completed")
                    else:
                        print(f"  !! {jid[:8]} failed: {j.get('error')}")
                    pending.remove(jid)
            except Exception as e:
                print(f"  [poll {jid[:8]}] error {e}")
        if pending:
            time.sleep(5)
    if pending:
        print(f"Timeout, still pending: {pending}")
        sys.exit(1)

all_jids = [JOB_MAP[pid] for pid,_ in PROJECTS if pid in JOB_MAP]
print(f"\n=== Polling {len(all_jids)} analyze jobs concurrently ===")
poll_all(all_jids, timeout=1800)

# Collect clips
all_clips = []
for pid, _ in PROJECTS:
    proj = get_project(pid)
    print(f"[project {pid[:8]}] clips={len(proj['clips'])} status={proj['status']}")
    for clip in proj["clips"]:
        all_clips.append((pid, clip))
        print(f"  clip {clip['id'][:8]} {clip['title'][:40]} {clip['start_time']:.1f}-{clip['end_time']:.1f} hook={ (clip.get('viral_hook') or '')[:60]}")

print(f"\nTotal clips: {len(all_clips)}")
if len(all_clips) == 0:
    print("No clips yet, exit")
    sys.exit(1)

random.seed(0)
random.shuffle(all_clips)
selected = all_clips[:30] if len(all_clips) >= 30 else all_clips
print(f"Selected {len(selected)} for render")

# Render
render_jobs = []
for pid, clip in selected:
    cid = clip["id"]
    # check if already rendered
    proj = get_project(pid)
    fresh = next((c for c in proj["clips"] if c["id"] == cid), None)
    if fresh and fresh.get("video_url"):
        print(f"[skip] {cid[:8]} already rendered")
        continue
    try:
        r = session.post(f"{BASE}/projects/{pid}/clips/{cid}/render", json={"orientation":"portrait"})
        print(f"[render {cid[:8]}] {r.status_code} {r.text[:200]}")
        if r.status_code == 409:
            continue
        r.raise_for_status()
        render_jobs.append((pid, cid, r.json()["id"]))
    except Exception as e:
        print(f"render failed {cid}: {e}")

print(f"\n=== Polling {len(render_jobs)} renders ===")
for pid, cid, jid in render_jobs:
    j = poll_job(jid, timeout=600)
    print(f"render {cid[:8]} -> {j['status']}")

# Download
out_dir = pathlib.Path("web/public/reels")
poster_dir = out_dir / "posters"
out_dir.mkdir(parents=True, exist_ok=True)
poster_dir.mkdir(parents=True, exist_ok=True)
reels_meta = []
idx = 1
handles = ["@timothy.ronald", "@theo.derick", "@jgi.show", "@raditya.dika"]
for pid, clip in selected:
    proj = get_project(pid)
    fresh = next((c for c in proj["clips"] if c["id"] == clip["id"]), None)
    if not fresh:
        continue
    signed = fresh.get("signed_video_url")
    thumb = fresh.get("signed_thumbnail_url")
    if not signed:
        print(f"no signed url for {fresh['id'][:8]}, skipping")
        continue
    out_path = out_dir / f"reel_{idx:02d}.mp4"
    print(f"[download {idx:02d}] -> {out_path}")
    try:
        with session.get(signed, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(out_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1<<20):
                    if chunk:
                        f.write(chunk)
        print(f"  {out_path.stat().st_size} bytes")
    except Exception as e:
        print(f"  failed {e}")
        continue
    poster_name = f"reel_{idx:02d}.jpg"
    poster_path = poster_dir / poster_name
    if thumb:
        try:
            with session.get(thumb, stream=True, timeout=30) as r:
                r.raise_for_status()
                with open(poster_path, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=1<<20):
                        f.write(chunk)
        except Exception as e:
            print(f"  poster fail {e}")
    # also probe duration
    import subprocess, json as js
    try:
        res = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1", str(out_path)], capture_output=True, text=True, timeout=10)
        dur = float(res.stdout.strip() or 0)
        dur_str = f"0:{int(dur):02d}" if dur < 60 else f"{int(dur)//60}:{int(dur)%60:02d}"
    except:
        dur_str = f"0:{int(fresh['end_time']-fresh['start_time']):02d}"
    p_idx = [p[0] for p in PROJECTS].index(pid) if pid in [p[0] for p in PROJECTS] else 0
    handle = handles[p_idx]
    hook = fresh.get("viral_hook") or fresh.get("title") or "Viral moment"
    # random views
    views = f"{random.randint(80,520)/10:.1f}M" if random.random()<0.5 else f"{random.randint(400,1800)}K"
    reels_meta.append({
        "file": f"/reels/reel_{idx:02d}.mp4",
        "poster": f"/reels/posters/{poster_name}" if poster_path.exists() else f"/reels/reel_{idx:02d}.mp4",
        "youtubeId": None,  # to be filled after manual YouTube upload
        "handle": handle,
        "hook": hook,
        "title": fresh.get("title"),
        "dur": dur_str,
        "tag": "Viral",
        "views": views,
        "project_id": pid,
        "clip_id": fresh["id"],
    })
    idx += 1

with open(out_dir / "reels.json", "w") as f:
    json.dump(reels_meta, f, indent=2)
print(f"\n=== Saved {len(reels_meta)} reels to {out_dir} ===")

# Purge if env
if os.environ.get("PURGE") == "1":
    print("\n=== Purging S3 ===")
    from dotenv import load_dotenv
    load_dotenv("backend/.env")
    from core.s3 import delete_object
    bucket = os.environ.get("S3_BUCKET")
    for pid, _ in PROJECTS:
        proj = get_project(pid)
        keys = []
        if proj.get("source_key"):
            keys.append(proj["source_key"])
        for c in proj["clips"]:
            if c.get("video_url"):
                keys.append(c["video_url"])
            if c.get("thumbnail_url"):
                keys.append(c["thumbnail_url"])
        for k in keys:
            try:
                delete_object(bucket, k)
                print(f"deleted {k}")
            except Exception as e:
                print(f"delete fail {k}: {e}")
        # purge project
        try:
            session.delete(f"{BASE}/projects/{pid}")
            print(f"soft deleted {pid}")
            # need to purge via hard delete after soft delete? use db?
        except Exception as e:
            print(e)
