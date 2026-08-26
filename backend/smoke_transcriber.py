"""Smoke test: local whisper.cpp vs AssemblyAI on the same audio.

Compares text output, word-level timings, and language detection so we can
see how close the local provider is to the cloud baseline.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Load backend/.env for ASSEMBLYAI_KEY without overriding real env.
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from core.transcriber import transcribe_with_words

AUDIO = "/tmp/opencode/osr.wav"

print("=" * 70)
print("SMOKE TEST: local whisper.cpp vs AssemblyAI")
print(f"audio: {AUDIO}")
print("=" * 70)

results = {}

for provider, key in (("local", ""), ("assemblyai", os.environ.get("ASSEMBLYAI_KEY", ""))):
    print(f"\n--- provider: {provider} ---")
    try:
        result = transcribe_with_words(AUDIO, key, provider=provider)
        results[provider] = result
        print(f"text     : {result.text!r}")
        print(f"language : {result.language!r}")
        print(f"words    : {len(result.words)}")
        for w in result.words[:6]:
            print(
                f"  {w['start_ms']:>6}ms-{w['end_ms']:>6}ms  {w['text']!r}"
            )
        if len(result.words) > 6:
            print("  ...")
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}")

if len(results) == 2:
    a, b = results["assemblyai"], results["local"]
    ta, tb = a.text.lower().strip(), b.text.lower().strip()
    wa = [w["text"].lower() for w in a.words]
    wb = [w["text"].lower() for w in b.words]
    overlap = len(set(wa) & set(wb)) / max(1, len(set(wa) | set(wb)))
    print("\n" + "=" * 70)
    print("COMPARISON")
    print("=" * 70)
    print(f"text identical      : {ta == tb}")
    print(f"word count          : assemblyai={len(wa)}  local={len(wb)}")
    print(f"word vocab overlap  : {overlap:.0%}")
    print(f"language detected   : assemblyai={a.language!r}  local={b.language!r}")
    if wa and wb:
        drift = abs(b.words[0]["start_ms"] - a.words[0]["start_ms"])
        print(f"first-word start drift: {drift}ms (assemblyai={a.words[0]['start_ms']}ms, local={b.words[0]['start_ms']}ms)")
