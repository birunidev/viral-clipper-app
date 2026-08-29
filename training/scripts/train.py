#!/usr/bin/env python3
"""LoRA finetune Qwen3-4B on clip-viral scoring (9000/1000) — QLoRA 4bit for RTX 5060 8GB."""
import argparse, json, os, yaml
from pathlib import Path

import torch
from datasets import Dataset, load_dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, TrainingArguments, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer

def load_jsonl_messages(path: str):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line=line.strip()
            if not line: continue
            obj = json.loads(line)
            msgs = obj.get("messages", [])
            # convert to single text via chat template later; keep as messages
            rows.append({"messages": msgs})
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="training/configs/lora_qwen3_4b.yaml")
    ap.add_argument("--dry-run", action="store_true", help="tokenize only + 10 steps")
    ap.add_argument("--max-steps", type=int, default=None)
    args = ap.parse_args()

    cfg = yaml.safe_load(open(args.config, encoding="utf-8"))
    base = cfg["base_model"]
    train_path = cfg["datasets"]["train"]
    val_path = cfg["datasets"]["val"]
    out = cfg["output_dir"]
    lora_cfg = cfg["lora"]
    tr = cfg["training"]

    # resolve relative to repo root if needed
    repo_root = Path(__file__).resolve().parents[2]
    def resolve(p):
        pp = Path(p)
        if pp.is_absolute() and pp.exists(): return str(pp)
        cand = repo_root / p
        if cand.exists(): return str(cand)
        cand2 = Path.cwd() / p
        if cand2.exists(): return str(cand2)
        return str(pp)
    train_path = resolve(train_path)
    val_path = resolve(val_path)

    print(f"[train] base={base} train={train_path} val={val_path} out={out}")
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if hf_token:
        print(f"[train] using HF_TOKEN (hf_***{hf_token[-4:]})")
    tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True, token=hf_token)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    tok.padding_side = "right"

    def format_messages(ex):
        # apply chat template if available, else simple concat
        try:
            text = tok.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=False)
        except Exception:
            parts = []
            for m in ex["messages"]:
                parts.append(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>")
            text = "\n".join(parts)
        return {"text": text}

    train_rows = load_jsonl_messages(train_path)
    val_rows = load_jsonl_messages(val_path)
    if args.dry_run:
        train_rows = train_rows[:32]
        val_rows = val_rows[:32]
        print(f"[dry-run] sliced to {len(train_rows)}/{len(val_rows)}")

    train_ds = Dataset.from_list(train_rows).map(format_messages)
    val_ds = Dataset.from_list(val_rows).map(format_messages)

    # Platform-aware 4bit: Windows has no bitsandbytes build → fallback, Linux/Colab must use 4bit for T4 16GB
    import sys as _sys
    _is_windows = _sys.platform == "win32"
    use_bnb = True
    bnb = None
    try:
        import bitsandbytes  # noqa: F401
        # T4 (sm75) has no bf16 — use fp16 for 4bit compute, Ampere+ uses bf16
        _bnb_dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
        bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=_bnb_dtype)
    except ImportError as e:
        if _is_windows:
            print(f"[train] bitsandbytes not available on Windows ({e}) — using bf16/fp16 without 4bit quant")
            use_bnb = False
        else:
            # Linux/Colab: 4bit is required for T4 4B — fail fast with hint
            raise ImportError(f"bitsandbytes required on Linux/Colab for 4bit QLoRA but not installed: {e}. Run: pip install bitsandbytes==0.46.1") from e
    if use_bnb and bnb is not None:
        model = AutoModelForCausalLM.from_pretrained(base, trust_remote_code=True, token=hf_token, quantization_config=bnb, device_map="auto", attn_implementation="eager")
        model = prepare_model_for_kbit_training(model)
    else:
        model = AutoModelForCausalLM.from_pretrained(base, trust_remote_code=True, token=hf_token, dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16, device_map="auto", attn_implementation="eager")
        # gradient checkpointing still works without kbit wrapper
        if hasattr(model, "gradient_checkpointing_enable"):
            try: model.gradient_checkpointing_enable()
            except: pass
    peft_cfg = LoraConfig(
        r=lora_cfg["r"], lora_alpha=lora_cfg["alpha"], lora_dropout=lora_cfg["dropout"],
        target_modules=lora_cfg["target_modules"], bias=lora_cfg.get("bias","none"), task_type=lora_cfg.get("task_type","CAUSAL_LM")
    )
    model = get_peft_model(model, peft_cfg)
    model.print_trainable_parameters()

    max_seq = tr.get("max_seq_len", 3072)
    max_steps = args.max_steps if args.max_steps is not None else (-1 if not args.dry_run else 10)
    epochs = 1 if args.dry_run else tr.get("epochs", 2)

    # warmup_ratio renamed in older transformers — use warmup_steps fallback
    wr = tr.get("warmup_ratio", 0.03)
    # TrainingArguments compat: newer uses warmup_ratio, older uses warmup_steps
    import inspect as _inspect
    _sig = _inspect.signature(TrainingArguments.__init__)
    _has_warmup_ratio = "warmup_ratio" in _sig.parameters
    _warmup_kw = {"warmup_ratio": wr} if _has_warmup_ratio else {"warmup_steps": max(10, int(0.03*9198/1))}
    # Colab T4 (Turing, sm75) has no bf16/tf32 — auto-downgrade to fp16
    _is_ampere = False
    _bf16_ok = False
    try:
        if torch.cuda.is_available():
            _cap = torch.cuda.get_device_capability(0)
            _is_ampere = _cap[0] >= 8
            _bf16_ok = torch.cuda.is_bf16_supported()
    except: pass
    _want_bf16 = bool(tr.get("bf16", True))
    _want_tf32 = bool(tr.get("tf32", True))
    _use_bf16 = _want_bf16 and _bf16_ok
    _use_tf32 = _want_tf32 and _is_ampere
    # fp16 fallback when bf16 not available (T4)
    _use_fp16 = not _use_bf16
    # Windows fallback needs adamw_torch, Linux/Colab 4bit can use paged_adamw_8bit
    _optim = tr.get("optim", "adamw_torch")
    if not use_bnb and _optim == "paged_adamw_8bit":
        _optim = "adamw_torch"
        print(f"[train] Windows without 4bit — switching optim {_optim} (was paged_adamw_8bit)")
    targs = TrainingArguments(
        output_dir=out,
        num_train_epochs=epochs,
        max_steps=max_steps,
        per_device_train_batch_size=tr.get("per_device_batch", 2),
        gradient_accumulation_steps=tr.get("grad_accum", 4),
        learning_rate=tr.get("lr", 2e-4),
        **_warmup_kw,
        lr_scheduler_type=tr.get("lr_scheduler", "cosine"),
        weight_decay=tr.get("weight_decay", 0.01),
        logging_steps=tr.get("logging_steps", 25),
        # compat: eval_strategy vs evaluation_strategy
        **({"eval_strategy": "steps"} if "eval_strategy" in _sig.parameters else {"evaluation_strategy": "steps"}),
        eval_steps=tr.get("eval_steps", 250) if not args.dry_run else 5,
        save_steps=tr.get("save_steps", 500) if not args.dry_run else 10,
        save_total_limit=2,
        bf16=_use_bf16,
        fp16=_use_fp16,
        tf32=_use_tf32,
        gradient_checkpointing=tr.get("gradient_checkpointing", True),
        optim=_optim,
        seed=tr.get("seed", 42),
        report_to="none",
        remove_unused_columns=False,
    )

    # SFTTrainer API compat + packing for T4 speed (packs short 9198 rows into 2048 blocks, ~3x faster)
    import inspect as _inspect2
    _sft_sig = _inspect2.signature(SFTTrainer.__init__)
    _sft_kwargs = {}
    if "dataset_text_field" in _sft_sig.parameters:
        _sft_kwargs["dataset_text_field"] = "text"
    elif "formatting_func" in _sft_sig.parameters:
        _sft_kwargs["formatting_func"] = lambda ex: ex["text"]
    # max_seq_length vs max_seq_len naming
    if "max_seq_length" in _sft_sig.parameters:
        _sft_kwargs["max_seq_length"] = max_seq
    elif "max_seq_len" in _sft_sig.parameters:
        _sft_kwargs["max_seq_len"] = max_seq
    if "packing" in _sft_sig.parameters:
        # enable packing on Linux/Colab for speed, keep False on Windows if needed for debugging
        _want_packing = bool(tr.get("packing", True))
        _sft_kwargs["packing"] = _want_packing
    trainer = SFTTrainer(
        model=model,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        args=targs,
        **_sft_kwargs,
    )
    trainer.train()
    trainer.save_model(out)
    tok.save_pretrained(out)
    print(f"[train] saved LoRA to {out}")
    # also save merged for GGUF export convenience
    try:
        merged = trainer.model.merge_and_unload()
        merged_dir = os.path.join(out, "merged")
        os.makedirs(merged_dir, exist_ok=True)
        merged.save_pretrained(merged_dir)
        tok.save_pretrained(merged_dir)
        print(f"[train] merged HF to {merged_dir} — run export_gguf.py for GGUF")
    except Exception as e:
        print(f"[train] merge skipped: {e}")

if __name__ == "__main__":
    main()
