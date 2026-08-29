# ClipZard Qwen3-4B Clip-Viral LoRA — scoring model (standalone, not backend/)

Uses `datasets/qwen3_clip_viral_*` (9000 train / 1000 val) — messages format, assistant is JSON with 9 scores. Trusts LLM for title/hook; this model only scores/ranks segments.

## Quick start (Windows MSYS2 RTX 5060 8GB)

```bash
python -m venv /tmp/training-venv
/tmp/training-venv/bin/python -m pip install -r training/requirements.txt

# smoke tokenize + 10-step dry run
/tmp/training-venv/bin/python training/scripts/train.py --config training/configs/lora_qwen3_4b.yaml --dry-run --max-steps 10

# full train (2 epochs ~ ~1.5h on 5060)
/tmp/training-venv/bin/python training/scripts/train.py --config training/configs/lora_qwen3_4b.yaml

# eval validation
/tmp/training-venv/bin/python training/scripts/evaluate.py --model training/outputs/qwen3-4b-clip-viral-lora

# build multilingual augmentation (EN→ID etc) then re-train
/tmp/training-venv/bin/python training/scripts/build_multilingual.py --langs id --ratio 0.3
```

## Outputs
- LoRA adapter: `training/outputs/qwen3-4b-clip-viral-lora/`
- Merged HF: `training/outputs/.../merged/` (for GGUF)
- GGUF Q4_K_M: use `training/scripts/export_gguf.py` (requires llama.cpp)

## Multilingual
Helper `build_multilingual.py` translates a slice of train EN→requested langs (needs `OPENAI_API_KEY` or local Marian/NLLB) into new jsonl to mix in for EN/ID etc coverage. Current train is EN-only; val remains EN for baseline, plus translated val slice for ID check.
