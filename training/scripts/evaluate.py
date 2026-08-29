#!/usr/bin/env python3
"""Evaluate LoRA scoring model on validation 1000 — JSON validity, score MAE, clip_quality acc."""
import argparse, json, re
from pathlib import Path
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

JSON_RE = re.compile(r"\{.*\}", re.S)

def parse_json(text: str):
    m = JSON_RE.search(text)
    if not m: return None
    try: return json.loads(m.group(0))
    except: return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="LoRA output dir")
    ap.add_argument("--base", default=None)
    ap.add_argument("--val", default="datasets/qwen3_clip_viral_validation_1000.jsonl")
    ap.add_argument("--max-samples", type=int, default=100)
    args = ap.parse_args()
    repo_root = Path(__file__).resolve().parents[2]
    # Colab may be at /content or /content/clipzard — search common roots
    search_roots = [repo_root, Path.cwd(), Path("/content"), Path("/content/clipzard"), Path(".").resolve()]
    def resolve(p):
        pp=Path(p)
        if pp.is_absolute() and pp.exists(): return str(pp)
        for r in search_roots:
            cand=(r/p).resolve()
            if cand.exists(): return str(cand)
            # also try relative to root without training prefix
            cand2=(r/Path(p).name).resolve()
            if cand2.exists(): return str(cand2)
        # fallback to repo_root
        cand=repo_root/p
        if cand.exists(): return str(cand)
        return str(pp)
    val_path = resolve(args.val)
    model_path = resolve(args.model)
    # if still not found, search for any lora outputs
    if not Path(model_path).exists() or not (Path(model_path)/"adapter_config.json").exists():
        print(f"[eval] not found at {model_path}")
        print("[eval] searching for any lora outputs...")
        for r in search_roots:
            for cand in [r/"training"/"outputs", r/"outputs", r/"."]:
                if cand.exists():
                    for d in cand.iterdir():
                        if (d/"adapter_config.json").exists():
                            print(f"  found: {d}")
        # also check if training still running
        print("[eval] training may still be running — check training/full.log for 'saved LoRA'")
        return
    # infer base from adapter_config if not given
    base = args.base
    if not base:
        try:
            cfg=json.load(open(Path(model_path)/"adapter_config.json",encoding="utf-8"))
            base=cfg.get("base_model_name_or_path","Qwen/Qwen3-4B")
        except: base="Qwen/Qwen3-4B"
    print(f"[eval] base={base} lora={model_path} val={val_path}")
    tok=AutoTokenizer.from_pretrained(base, trust_remote_code=True)
    if tok.pad_token is None: tok.pad_token=tok.eos_token
    base_model=AutoModelForCausalLM.from_pretrained(base, trust_remote_code=True, device_map="auto", torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32)
    model=PeftModel.from_pretrained(base_model, model_path)
    model.eval()

    rows=[]
    with open(val_path,encoding="utf-8") as f:
        for line in f:
            if line.strip(): rows.append(json.loads(line))
    rows=rows[:args.max_samples]
    valid=0; mae_sum=0; mae_n=0; acc=0; acc_n=0
    for r in rows:
        msgs=r["messages"]
        target=json.loads(msgs[-1]["content"]) if isinstance(msgs[-1].get("content"),str) else {}
        # build prompt without assistant
        prompt_msgs=msgs[:-1]
        try:
            prompt=tok.apply_chat_template(prompt_msgs, tokenize=False, add_generation_prompt=True)
        except:
            prompt="\n".join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>" for m in prompt_msgs)+"\n<|im_start|>assistant\n"
        inputs=tok(prompt, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out=model.generate(**inputs, max_new_tokens=512, temperature=0.1, do_sample=False, pad_token_id=tok.eos_token_id)
        gen=tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        pred=parse_json(gen)
        if pred is None:
            continue
        valid+=1
        # viral_score MAE
        if "viral_score" in pred and "viral_score" in target:
            try: mae_sum+=abs(float(pred["viral_score"])-float(target["viral_score"])); mae_n+=1
            except: pass
        if pred.get("clip_quality")==target.get("clip_quality"):
            acc+=1; acc_n+=1
        else:
            acc_n+=1
    print(f"[eval] samples={len(rows)} valid_json={valid}/{len(rows)} ({valid/len(rows):.1%})")
    if mae_n: print(f"[eval] viral_score MAE={mae_sum/mae_n:.4f} (n={mae_n})")
    if acc_n: print(f"[eval] clip_quality acc={acc/acc_n:.1%} (n={acc_n})")

if __name__=="__main__":
    main()
