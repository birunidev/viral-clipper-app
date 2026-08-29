#!/usr/bin/env python3
"""Download Qwen3 model to .hf-cache with HF_TOKEN and resume.
Usage:
  python training/scripts/download_model.py --model Qwen/Qwen3-4B
  HF_TOKEN=hf_xxx python training/scripts/download_model.py --model Qwen/Qwen3-4B --cache .hf-cache
"""
import argparse, os
from pathlib import Path

# load training/.env
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except:
    for p in [Path(__file__).resolve().parents[1] / ".env", Path(__file__).resolve().parents[2] / ".env"]:
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if not line.strip() or line.strip().startswith("#") or "=" not in line: continue
                k,v=line.split("=",1)
                os.environ.setdefault(k.strip(), v.strip())

from huggingface_hub import snapshot_download

ap=argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen3-4B")
ap.add_argument("--cache", default=None, help="hf cache dir, default .hf-cache or HF_HOME")
args=ap.parse_args()

cache = args.cache or os.environ.get("HF_HOME") or os.environ.get("HUGGINGFACE_HUB_CACHE") or str(Path(__file__).resolve().parents[2] / ".hf-cache")
os.environ["HF_HOME"] = cache
os.environ["HUGGINGFACE_HUB_CACHE"] = cache
token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
print(f"[download] model={args.model} cache={cache} token={'yes' if token else 'no'}")
# enable XET high perf if available
os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"

# snapshot_download will resume incomplete blobs
path = snapshot_download(repo_id=args.model, local_dir_use_symlinks=False, max_workers=4, token=token)
print(f"[download] done -> {path}")
print(f"[download] cached blobs in {cache} — mount this to docker as /hf-cache for training")
