# 03 — VAD / Dead-Air + Filler / False-Start → Tighten (with sync)

**Goal:** `podcast → tighter` without breaking A/V. Candidate `removals` feed `TimelineMapper 01`.

## Files

* **New** `electron/src/services/silenceDetector.ts` — `ffmpeg -af silencedetect=noise=-30dB:d=0.3` parse `silence_start|end|duration type:silence` → classify `<300 keep | 300-800 usually keep | 800-1500 candidate | >1500 strong` `config.json tightness` per spec Feature 6 example `{start:42.1,end:44.4,duration:2.3}`.
* **New** `electron/src/services/fillerDetector.ts` — `timeline_words[]` `words[].text,start_ms,end_ms` × lexicons `EN [um,uh,erm,you know,basically, I mean, kind of, sort of]` `ID [eee,eh,anu,apa namanya,kayak,gitu,maksudnya,sebenernya]` (`spec F7`) → `{start:22.15,end:22.58,type:filler,text:"um",confidence:0.96}` candidates. No blind removal — `confidence` + `tightness` gate.
* **New** `electron/src/services/falseStartDetector.ts` (F8) — `transcript` unfinished `So the biggest thing—` / `Actually what I mean is—` → prefer final formulation, never invent words, via `analyzer` Qwen review for ambiguous (F8 `Do not alter meaning`).
* **Modify** `electron/src/services/timeline.ts:01` integrate `removals` → `cutter` concat `-f concat` / `-vf trim` + `-af atrim` keep sync (critical spec Timeline Remapping). `electron/src/services/captions.ts:102` rerun `buildAss` on `mapWords`, `electron/renderer draw.ts:60 buildCaptionEvents` remapped. **No web/backend.**

## Config

* Thresholds `300/800/1500` in `editPlan.output.tightness: natural|social|aggressive` (`social` default). `Natural: only obvious dead air, minimal filler`, `Social: filler + 800ms, clear false starts`, `Aggressive: more silence + repetition` (spec F9).

## Tasks

- [ ] `silenceDetector.ts` parse ffmpeg stderr, `total_removed`/`output_duration` via `TimelineMapper`.
- [ ] `fillerDetector.ts` EN+ID lexicons, `confidence`, `Map editPlan.output.removeFiller:boolean`.
- [ ] `falseStartDetector` transcript neatest — leave stub if Qwen needed (handoffs to `05`).
- [ ] `timeline.ts` concat `A/V` keep sync after `12.0-13.0 + 21.2-22.8` removals → `captions/camera/zoom` synced, no scattered `+offset`.
- [ ] Tests `tests/electron/test_vad, test_filler, test_timeline: removals remap 12→11, captions sync, evenDown H264`.

## Acceptance

* Manual: `60 min` `12.0-13.0` + `21.2-22.8` removals render `concat` file playable, `captions` `word` at `22.15` maps to `21.95` output, no drift; `Aggressive` shorter than `Natural`.
* `npm --prefix electron run typecheck` green.

## Exit

`PROGRESS.md 03 [x]` → `04`. No web/backend touched.

## Instructor

Next: `04-speaker.md`. Keep electron-only — local `webrtcvad` vs `silero-vad` choice; guard thresholds with `editPlan.tightness`.
