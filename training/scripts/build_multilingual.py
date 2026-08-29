#!/usr/bin/env python3
"""
Build multilingual training augmentation for scoring.
Copies EN train slice and translates Transcript segment -> target langs (e.g. id).
Keeps assistant JSON labels identical (scores are language-agnostic).

Usage:
  python training/scripts/build_multilingual.py --langs id --ratio 0.3
  OPENAI_API_KEY=... python ... (uses gpt-4o-mini)
  # without key, falls back to no-op copy (marks translated=false) for manual post-edit

Outputs: datasets/qwen3_clip_viral_train_multilingual_<langs>.jsonl
"""
import argparse, json, os, random
from pathlib import Path

# load training/.env if present
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except ImportError:
    # fallback manual
    for p in [Path(__file__).resolve().parents[1] / ".env", Path(__file__).resolve().parents[2] / ".env"]:
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                line=line.strip()
                if not line or line.startswith("#") or "=" not in line: continue
                k,v=line.split("=",1)
                os.environ.setdefault(k.strip(), v.strip())

def translate_http(text: str, lang: str, api_key: str, base_url: str, model: str):
    import json as js, time as _time
    import subprocess
    lang_name = {"id":"Indonesian (Bahasa Indonesia)", "ms":"Malay", "es":"Spanish", "ja":"Japanese", "en":"English"}.get(lang, lang)
    payload = js.dumps({
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role":"system","content":f"Translate the following transcript segment to {lang_name}. Keep meaning, keep short. Return only the translation."},
            {"role":"user","content": text},
        ]
    })
    import json as _j
    for attempt in range(3):
        try:
            proc = subprocess.run(
                ["curl","-s","--max-time","60", f"{base_url.rstrip('/')}/chat/completions",
                 "-H", f"Authorization: Bearer {api_key}",
                 "-H", "Content-Type: application/json",
                 "-H", "HTTP-Referer: https://clipzard.web.id",
                 "-H", "X-Title: clipzard-training",
                 "-d", payload],
                capture_output=True, text=True, timeout=70
            )
            if proc.returncode!=0:
                print(f"[http translate] curl failed {lang} attempt {attempt}: {proc.stderr[:200]} stdout:{proc.stdout[:200]}")
                _time.sleep(1.5*(attempt+1)); continue
            out = proc.stdout.strip()
            if not out:
                print(f"[http translate] empty response {lang} attempt {attempt}")
                _time.sleep(1.5*(attempt+1)); continue
            data = _j.loads(out)
            if "error" in data:
                msg = str(data["error"])
                print(f"[http translate] api error {lang} attempt {attempt}: {msg[:400]}")
                if "429" in msg or "rate" in msg.lower():
                    _time.sleep(2.5*(attempt+1)); continue
                return text, False
            return data["choices"][0]["message"]["content"].strip(), True
        except Exception as e:
            print(f"[http translate] failed {lang} attempt {attempt}: {e}")
            _time.sleep(1.5*(attempt+1))
    return text, False

def translate_stub(text: str, lang: str, client=None, model=None, api_key=None, base_url=None):
    if client is not None:
        if model is None:
            model = os.environ.get("OPENROUTER_TRANSLATE_MODEL") or os.environ.get("OPENROUTER_EVAL_MODEL") or "google/gemini-2.0-flash-001"
        try:
            lang_name = {"id":"Indonesian (Bahasa Indonesia)", "ms":"Malay", "es":"Spanish", "ja":"Japanese", "en":"English"}.get(lang, lang)
            resp = client.chat.completions.create(model=model, temperature=0.2, messages=[
                {"role":"system","content":f"Translate the following transcript segment to {lang_name}. Keep meaning, keep short. Return only the translation."},
                {"role":"user","content": text},
            ])
            return resp.choices[0].message.content.strip(), True
        except Exception as e:
            print(f"[multilingual] translate failed {lang}: {e}")
            return text, False
    # fallback http path (no openai SDK)
    if api_key and base_url:
        m = model or os.environ.get("OPENROUTER_TRANSLATE_MODEL") or "google/gemini-2.0-flash-001"
        return translate_http(text, lang, api_key, base_url, m)
    return text, False

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--langs", default="id", help="comma langs e.g. id,ms,es")
    ap.add_argument("--ratio", type=float, default=0.3, help="fraction of train to augment per lang")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--src", default="datasets/qwen3_clip_viral_train_9000.jsonl")
    ap.add_argument("--out", default=None)
    args=ap.parse_args()
    random.seed(args.seed)
    repo_root=Path(__file__).resolve().parents[2]
    def resolve(p):
        pp=Path(p)
        if pp.is_absolute() and pp.exists(): return str(pp)
        cand=repo_root/p
        if cand.exists(): return str(cand)
        return str(pp)
    src=resolve(args.src)
    langs=[s.strip().lower() for s in args.langs.split(",") if s.strip()]
    rows=[]
    with open(src,encoding="utf-8") as f:
        for line in f:
            if line.strip(): rows.append(json.loads(line))
    k=int(len(rows)*args.ratio)
    sample=random.sample(rows, min(k, len(rows)))
    # try openai client
    client=None
    api_key = os.environ.get("OPENAI_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL") or os.environ.get("OPENROUTER_BASE_URL") or ("https://openrouter.ai/api/v1" if api_key and api_key.startswith("sk-or-") else None)
    translate_model = os.environ.get("OPENROUTER_TRANSLATE_MODEL") or "google/gemini-2.0-flash-001"
    if api_key:
        try:
            from openai import OpenAI
            client=OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI()
            print(f"[multilingual] using SDK client base_url={base_url or 'default'} model={translate_model}")
        except Exception as e:
            print(f"[multilingual] SDK not available ({e}) — using direct HTTP to {base_url}")
            client=None
    else:
        print("[multilingual] no OPENAI_API_KEY — will copy EN as placeholder (translated=false); add training/.env")
    out_rows=[]
    import time as _t
    for lang in langs:
        print(f"[multilingual] translating {len(sample)} rows -> {lang} via {translate_model} ...", flush=True)
        for idx, r in enumerate(sample):
            if idx % 10 == 0:
                print(f"[multilingual] {lang} {idx}/{len(sample)}", flush=True)
            # throttle to avoid 429
            _t.sleep(0.35)
            msgs=r["messages"]
            # user message contains Transcript segment: after \n\nTranscript segment:\n
            user_idx = next((i for i,m in enumerate(msgs) if m["role"]=="user"), None)
            if user_idx is None: continue
            content=msgs[user_idx]["content"]
            # split on Transcript segment:\n
            if "Transcript segment:\n" in content:
                header, seg = content.split("Transcript segment:\n",1)
                trans, ok = translate_stub(seg, lang, client, translate_model, api_key, base_url or "https://openrouter.ai/api/v1")
                new_content = header+"Transcript segment:\n"+trans
                new_msgs = [m.copy() for m in msgs]
                new_msgs[user_idx] = {**new_msgs[user_idx], "content": new_content}
                # add lang hint to system
                new_msgs[0] = {**new_msgs[0], "content": new_msgs[0]["content"]+f"\nTranscript language: {lang}."}
                out_rows.append({"messages": new_msgs, "meta": {"augment_lang": lang, "translated": ok, "src":"en"}})
            else:
                out_rows.append(r)
    # write augmented combined file
    out = args.out or str(repo_root / f"datasets/qwen3_clip_viral_train_multilingual_{'+'.join(langs)}_{k}each.jsonl")
    # combine original + augmented for training convenience
    combined = rows + out_rows
    # also write just augmented
    aug_path = str(repo_root / f"datasets/qwen3_clip_viral_aug_{'+'.join(langs)}_{k}each.jsonl")
    with open(aug_path,"w",encoding="utf-8") as f:
        for r in out_rows: f.write(json.dumps(r, ensure_ascii=False)+"\n")
    print(f"[multilingual] augmented {len(out_rows)} rows ({langs}, {k} each, total sample {len(sample)}) -> {aug_path}")
    print(f"[multilingual] to train on combined, use: --train {aug_path} or concat manually; example combined size {len(combined)}")
    # write combined if requested via --out
    if args.out:
        with open(out,"w",encoding="utf-8") as f:
            for r in combined: f.write(json.dumps(r, ensure_ascii=False)+"\n")
        print(f"[multilingual] combined -> {out}")

if __name__=="__main__":
    main()
