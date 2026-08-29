#!/usr/bin/env python3
"""Export merged HF to GGUF Q4_K_M via llama.cpp (needs llama.cpp clone)."""
import argparse, os, subprocess, pathlib
def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--hf", required=True, help="merged HF dir")
    ap.add_argument("--llamacpp", default="../llama.cpp")
    ap.add_argument("--out", default=None)
    ap.add_argument("--quant", default="Q4_K_M")
    args=ap.parse_args()
    hf=pathlib.Path(args.hf).resolve()
    llamacpp=pathlib.Path(args.llamacpp).resolve()
    out=pathlib.Path(args.out).resolve() if args.out else hf.parent / f"{hf.name}.gguf"
    convert=llamacpp / "convert_hf_to_gguf.py"
    quant=llamacpp / "llama-quantize"
    if not convert.exists():
        print(f"missing {convert} — clone https://github.com/ggerganov/llama.cpp")
        raise SystemExit(1)
    tmp = hf.parent / f"{hf.name}.f16.gguf"
    print(f"[export] convert {hf} -> {tmp}")
    subprocess.check_call(["python", str(convert), str(hf), "--outfile", str(tmp), "--outtype", "f16"])
    print(f"[export] quantize {tmp} -> {out} ({args.quant})")
    if quant.exists():
        subprocess.check_call([str(quant), str(tmp), str(out), args.quant])
        print(f"[export] GGUF quantized -> {out}")
    else:
        print(f"[export] no quantizer at {quant}, leaving F16 at {tmp}")
        out=tmp
    print(f"[export] done -> {out} . Set LLM_MODEL_FILE or move to userData/models/llm/")
if __name__=="__main__": main()
