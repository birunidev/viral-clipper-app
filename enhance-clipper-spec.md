You are improving an existing AI viral clipper application.

Do NOT rebuild the application from scratch.

Your job is to inspect the current repository, understand how the app already works, then incrementally evolve it from a transcript-based viral clip finder into a more intelligent AI short-form video editor.

The end goal is:

> Upload a long podcast/interview/video → detect strong viral moments → tighten the speech → automatically reframe faces for 9:16/4:5/16:9 depends on user demand → switch speakers intelligently → produce a polished short that feels human-edited.

---

# First: Inspect the Existing Repository

Before modifying code, thoroughly inspect the repository.

Understand:

- frontend framework and structure
- backend/API
- video upload flow
- job/queue system
- database schema
- video storage
- transcription pipeline
- current Whisper/STT implementation
- current Qwen 2.5 7B integration
- current viral clip scoring logic
- FFmpeg/video processing implementation
- caption generation
- existing editor/preview UI
- current configuration system
- tests
- Docker/container setup
- GPU/CPU assumptions

Do not assume the stack.

Follow the repository's existing conventions.

Preserve all current features.

Before implementation, create a concise internal architecture map and implementation plan based on the actual codebase.

---

# Product Goal

The current application probably behaves approximately like:

```text
Long video
    ↓
Transcript
    ↓
Qwen
    ↓
Interesting timestamps
    ↓
Clip
```

Upgrade it toward:

```text
                         LONG VIDEO
                              │
              ┌───────────────┼───────────────┐
              ↓               ↓               ↓
           AUDIO           TRANSCRIPT        VIDEO
              │               │               │
              │               │          face detection
              │               │          face tracking
              │               │          scene detection
              │               │
              ↓               ↓               ↓
             VAD         QWEN 2.5 7B      VISUAL METADATA
              │               │               │
              └───────────────┼───────────────┘
                              ↓
                       EDITING INTELLIGENCE
                              ↓
                          EDIT PLAN
                              ↓
                           FFmpeg
                              ↓
                     POLISHED SHORT VIDEO
```

The application should evolve from:

> AI clip finder

into:

> AI short-form video editor

---

# Core Engineering Principle

Do not use Qwen for everything.

Qwen 2.5 7B should be the editor/director brain.

Specialized deterministic systems should handle precise tasks.

Use this separation:

```text
Computer Vision
"What is visible?"

Audio analysis
"What is happening in the audio?"

Qwen
"What should we do?"

Edit Plan
"Exactly what edits should occur?"

FFmpeg
"Execute those edits."
```

Do not send every video frame into Qwen.

Do not ask the LLM to generate/render video.

---

# Architecture Requirement: Unified Edit Plan

Introduce a canonical edit-plan representation if the repository does not already have one.

All AI decisions should ultimately become structured editing operations.

Example:

```json
{
  "version": 1,

  "source": {
    "video_id": "video_123"
  },

  "output": {
    "aspect_ratio": "9:16",
    "width": 1080,
    "height": 1920,
    "editing_style": "social"
  },

  "segments": [
    {
      "source_start": 120.2,
      "source_end": 132.5,

      "speaker_id": "speaker_1",

      "layout": "speaker_focus",

      "camera": {
        "target_face_id": "face_1",
        "zoom": 1.05
      }
    }
  ],

  "removals": [
    {
      "start": 124.1,
      "end": 124.7,
      "type": "filler"
    },
    {
      "start": 128.3,
      "end": 129.9,
      "type": "dead_air"
    }
  ],

  "visual_events": [
    {
      "time": 130.2,
      "type": "speaker_switch",
      "target": "speaker_2"
    }
  ]
}
```

Validate this schema strictly.

Keep analysis, decision-making, and rendering separated.

---

# Feature 1: Face Detection

Add local face detection to video analysis.

Requirements:

- detect faces from sampled frames
- use normalized bounding boxes
- support multiple faces
- avoid processing all 30/60 FPS frames unnecessarily
- cache results
- detect scene boundaries before assuming face identity continuity

Example metadata:

```json
{
  "timestamp": 14.2,
  "faces": [
    {
      "id": "face_1",
      "x": 0.22,
      "y": 0.14,
      "width": 0.2,
      "height": 0.39,
      "confidence": 0.97
    }
  ]
}
```

Use an appropriate lightweight local CV library/model compatible with the current stack.

Prefer simple and reliable implementations over oversized models.

---

# Feature 2: Face Tracking

Do not independently crop every detected frame.

Track faces through time.

The pipeline should resemble:

```text
sampled detections
       ↓
face identities
       ↓
tracking
       ↓
interpolation
       ↓
position smoothing
       ↓
camera path
```

Requirements:

- stable face IDs
- interpolation between sampled detections
- temporary occlusion handling
- smoothing
- no camera jitter
- reset tracking across major scene changes

Create a reusable abstraction for tracked subjects.

---

# Feature 3: Automatic 9:16 Reframing

When the user requests vertical output, generate a face-aware crop automatically.

For example:

```text
ORIGINAL

┌──────────────────────────────────┐
│                                  │
│      Speaker A      Speaker B    │
│                                  │
└──────────────────────────────────┘

                  ↓

VERTICAL

┌──────────────┐
│              │
│  Speaker A   │
│              │
│              │
└──────────────┘
```

Do not simply center-crop the source.

Determine crop position based on:

- active speaker
- face bounding box
- face size
- movement
- safe headroom
- composition
- nearby faces
- scene changes

The output crop should behave like a virtual camera operator.

---

# Feature 4: Smooth Virtual Camera

Generate a camera path instead of abrupt crop jumps.

The virtual camera should support:

- follow
- hold
- smooth pan
- speaker switch
- subtle punch-in
- reset after scene change

Avoid excessive motion.

Introduce configurable smoothing values.

Example:

```json
{
  "start": 20,
  "end": 25,
  "camera": {
    "from_x": 0.21,
    "to_x": 0.27,
    "easing": "smooth",
    "duration": 0.5
  }
}
```

The output should feel intentionally framed rather than algorithmically shaky.

---

# Feature 5: Speaker-Aware Reframing

If speaker diarization already exists, reuse it.

Otherwise introduce it carefully without unnecessarily replacing the transcription pipeline.

Combine:

```text
speaker timestamps
+
tracked faces
```

to determine who should be visible.

Example:

```text
00:00 Speaker 1
00:04 Speaker 1
00:08 Speaker 2
00:15 Speaker 1
```

Camera:

```text
Speaker 1
   ↓
Speaker 2
   ↓
Speaker 1
```

Add protection against excessive switching.

For example:

- minimum shot duration
- ignore very short interjections
- avoid switch when confidence is low
- keep both people visible when appropriate

---

# Feature 6: Dead-Air Detection

Introduce or improve Voice Activity Detection.

Detect candidate silence intervals.

Example:

```json
{
  "start": 42.1,
  "end": 44.4,
  "duration": 2.3,
  "type": "silence"
}
```

Do not automatically remove every silence.

Classify pauses by duration.

Suggested initial behavior:

```text
< 300ms
keep

300-800ms
usually keep

800-1500ms
candidate

> 1500ms
strong removal candidate
```

These thresholds must be configurable.

Preserve dramatic or meaningful pauses where appropriate.

---

# Feature 7: Filler Word Detection

Detect removable filler speech using word timestamps.

Support at least English and Indonesian.

Examples:

English:

```text
um
uh
erm
you know
basically
I mean
kind of
sort of
```

Indonesian:

```text
eee
eh
anu
apa namanya
kayak
gitu
maksudnya
sebenernya
```

Do not blindly remove every occurrence.

Generate candidate edits.

For example:

```json
{
  "start": 22.15,
  "end": 22.58,
  "type": "filler",
  "text": "um",
  "confidence": 0.96
}
```

Qwen may review ambiguous fillers based on transcript context.

---

# Feature 8: False Starts and Repeated Takes

Detect:

- unfinished sentences
- repeated starts
- self corrections
- abandoned phrases
- repeated wording

Example:

```text
"So the biggest thing—"

"Actually what I mean is—"

"The biggest mistake founders make is..."
```

The system should prefer the complete final formulation.

Use transcript analysis for this.

Do not alter semantic meaning.

Never generate words the speaker did not say.

---

# Feature 9: Editing Tightness

Add an editing intensity option.

Use three modes initially:

```text
Natural
Social
Aggressive
```

Natural:

- preserve conversational rhythm
- remove only obvious dead air
- minimal filler cleanup
- minimal visual movement

Social:

- remove filler
- shorten dead air
- remove clear false starts
- dynamic face framing
- speaker switching
- occasional punch-ins

Aggressive:

- tighter speech
- more aggressive silence removal
- remove obvious repetition
- stronger pacing
- more frequent visual change

Store this setting in the edit plan.

Make behavior driven by configuration rather than hardcoded throughout the renderer.

---

# Feature 10: Better Viral Clip Selection

Improve the existing Qwen viral clip selection without replacing it unnecessarily.

Qwen should analyze:

- transcript
- hook strength
- standalone context
- payoff
- novelty
- emotional intensity
- practical value
- controversy/contrarian angle
- clarity
- audience relevance
- storytelling
- sentence completeness

Avoid choosing clips solely because individual sentences sound dramatic.

A good short should make sense without the viewer seeing the entire source video.

---

# Feature 11: Editorial Angles

For long videos, classify strong moments into different content angles.

Examples:

```text
Educational
Contrarian
Story
Emotional
Funny
Insight
Practical
Surprising
```

Avoid outputting five nearly identical clips.

The system should prefer content diversity.

Example result:

```json
[
  {
    "type": "contrarian",
    "title": "Why most SaaS advice is wrong",
    "score": 92
  },
  {
    "type": "story",
    "title": "The moment we nearly ran out of money",
    "score": 89
  },
  {
    "type": "educational",
    "title": "Three mistakes founders make",
    "score": 86
  }
]
```

---

# Feature 12: Story Reconstruction

Design the architecture so clips do not always need to be one contiguous source range.

Allow the AI to eventually construct:

```text
Hook
 ↓
Context
 ↓
Conflict
 ↓
Insight
 ↓
Payoff
```

from separate moments.

Example:

```text
08:21 Hook

12:42 Conflict

17:05 Insight

23:18 Payoff
```

Only combine sections when:

- they are semantically consistent
- pronouns/context still make sense
- the resulting narrative remains truthful
- the speaker's meaning is preserved

Never fabricate continuity.

Make this feature optional initially if implementation complexity is high.

The architecture should support it even if the first version only handles contiguous clips.

---

# Feature 13: Dynamic Zoom / Punch-In

Add subtle zoom emphasis.

Example:

```text
1.00x
 ↓
1.04x
 ↓
1.08x
 ↓
1.00x
```

Use sparingly.

Possible triggers:

- strong claim
- punchline
- surprising number
- emotionally strong sentence
- important conclusion

Do not generate random zoom effects simply to make the video look "AI edited."

---

# Feature 14: Layout Engine

Create a reusable layout system.

Initial layouts:

```text
speaker_focus
two_speaker
wide
split_screen
picture_in_picture
```

Example:

```json
{
  "layout": "speaker_focus",
  "target": "speaker_1"
}
```

Do not hardcode rendering logic directly into Qwen prompts.

Qwen selects layout names.

The renderer implements the layouts.

---

# Feature 15: Reaction-Aware Editing

Design support for meaningful reaction shots.

Example:

```text
Speaker A:
"I lost our entire budget."

Speaker B:
visible surprised reaction
```

Potential edit:

```text
Speaker A
    ↓
Reaction shot
    ↓
Speaker A
```

Do not force reaction detection into the first implementation if it creates instability.

Treat it as a modular analysis component.

---

# Qwen 2.5 7B Role

Use Qwen as the decision engine.

Inputs should include structured metadata such as:

```json
{
  "transcript": [],
  "speakers": [],
  "silences": [],
  "faces": [],
  "scenes": [],
  "candidate_clips": [],
  "editing_style": "social"
}
```

Expected Qwen responsibilities:

- viral clip ranking
- semantic understanding
- false-start detection
- ambiguous filler decisions
- intentional pause decisions
- editorial angle classification
- story selection
- layout decisions
- punch-in decisions
- edit-plan generation

Do not use Qwen for:

- face bounding-box detection
- per-frame tracking
- audio decoding
- cropping execution
- video encoding
- FFmpeg operations

---

# Structured Output

All Qwen outputs that influence rendering should use validated structured output.

Do not rely on parsing loose prose.

Create schemas/types.

Example:

```json
{
  "clip_score": 91,
  "angle": "contrarian",
  "reason_codes": ["strong_hook", "clear_payoff", "standalone_context"],
  "editing": {
    "tightness": "social",
    "preferred_layout": "speaker_focus"
  }
}
```

Use:

- schema validation
- retry on invalid output
- repair/fallback
- sensible deterministic defaults

Never let malformed AI output crash the processing job.

---

# Rendering

Reuse the current FFmpeg pipeline where possible.

The renderer should consume the edit plan.

Support:

- trimming
- concatenation
- audio cuts
- crop
- scale
- pan
- zoom
- overlays
- subtitles
- aspect ratios
- transitions

Avoid unnecessary intermediate encodes.

Keep the highest practical source resolution until final output.

For vertical output use:

```text
1080x1920
```

as the default final resolution unless the current system supports a configurable output.

Preserve audio/video sync after silence and filler removal.

This is critical.

---

# Timeline Remapping

When sections are removed from the source, all downstream timing must be correct.

For example:

```text
Source:

0s ─────────────── 60s

Remove:
12.0-13.0
21.2-22.8
```

The rendered timeline is no longer identical to source timestamps.

Introduce a proper timeline mapping abstraction.

All of these must remain synchronized:

- captions
- speaker changes
- camera changes
- zoom events
- layout changes
- audio
- video

Do NOT solve this using random timestamp offsets scattered throughout the codebase.

Create a canonical timeline transformation utility.

---

# Analysis Caching

Analyze each source once whenever possible.

Cache:

- transcript
- word timings
- VAD
- speakers
- face tracking
- scene detection
- visual metadata

Then allow generating:

```text
9:16
1:1
4:5
16:9
```

without repeating expensive analysis.

Similarly, changing editing style should not require retranscribing the source.

---

# Processing States

Improve job progress if the architecture supports it.

Example:

```text
Uploading
Transcribing
Analyzing audio
Analyzing video
Finding clips
Planning edit
Rendering
Completed
```

Errors should clearly identify which stage failed.

Do not report a generic "processing error" when a specific stage is known.

---

# Preview UI

Inspect the current design system before changing UI.

Do not introduce an unrelated visual style.

Add only the UI required to support the new capabilities.

Useful controls:

```text
Aspect Ratio
[ 9:16 ]

Editing Style
[ Natural | Social | Aggressive ]

Auto Reframe
[ on ]

Remove Dead Air
[ on ]

Remove Fillers
[ on ]

Speaker Switching
[ on ]

Dynamic Zoom
[ on ]
```

For generated clips, show useful metadata such as:

```text
Viral Score: 91

Angle:
Contrarian

Detected:
Strong hook
Clear payoff
2 filler edits
1 long pause removed
3 camera changes
```

Do not expose hidden chain-of-thought.

Only expose concise reason codes or editorial explanations.

---

# Timeline UI

If the application already has an editor/timeline, extend it.

If it does not, keep the first implementation simple.

Possible visualization:

```text
SOURCE

███████▒▒████████▒████████████

        ↑        ↑
      removed   filler

CAMERA

Speaker A ───── Speaker B ─── Speaker A

                     ↑
                   punch-in
```

Allow the user to disable individual automatic edits eventually.

Keep the underlying edit-plan representation editable.

---

# Modularity

Avoid one giant `processVideo()` function.

Prefer modules such as:

```text
VideoAnalyzer
TranscriptAnalyzer
SilenceDetector
FillerDetector
SpeakerAnalyzer
FaceDetector
FaceTracker
SceneDetector
ClipRanker
EditPlanner
TimelineMapper
VideoRenderer
```

Adapt names to the current repository conventions.

Do not introduce unnecessary microservices.

Use existing project boundaries whenever possible.

---

# Local-First Constraint

The goal is to keep the application able to operate with local models.

Current primary LLM:

```text
Qwen 2.5 7B
```

Do not introduce a required paid cloud AI dependency.

Optional integrations may be abstracted in the future, but local execution must remain first-class.

Use lightweight CV/audio components where practical.

---

# Performance

The system may process long podcast videos.

Optimize carefully.

Do not:

```text
run expensive AI inference
for every frame
for the entire 60-minute video
```

Instead:

```text
sample
 ↓
detect
 ↓
track
 ↓
interpolate
```

Process only selected viral candidate ranges at higher visual precision when possible.

For example:

```text
60 minute source
      ↓
coarse analysis
      ↓
10 candidate clips
      ↓
high-detail visual analysis on candidates
      ↓
render best clips
```

Prefer this over expensive full-resolution analysis of everything.

---

# Reliability

Every AI feature needs fallback behavior.

Examples:

If face detection fails:

```text
fallback → safe center crop
```

If speaker-to-face association fails:

```text
fallback → most prominent face
```

If Qwen edit-plan generation fails:

```text
fallback → original clip boundaries
```

If punch-in generation fails:

```text
fallback → normal speaker-focus crop
```

The application must still produce a usable clip.

---

# Implementation Strategy

Do not implement everything in one enormous PR/change.

Work incrementally.

Recommended order:

## Milestone 1

Build foundational abstractions:

- analysis result types
- edit-plan schema
- timeline mapping
- clean rendering contract

Do not unnecessarily change visible behavior yet.

---

## Milestone 2

Implement:

- face detection
- face tracking
- 9:16 auto reframe
- smoothing

Goal:

```text
Podcast → vertical crop follows face
```

This must work reliably before adding fancy editing.

---

## Milestone 3

Implement:

- VAD/dead-air detection
- filler detection
- speech tightening
- correct timeline remapping

Goal:

```text
Podcast → tighter version without breaking A/V sync
```

---

## Milestone 4

Combine:

- speaker timestamps
- face tracking
- camera switching

Goal:

```text
Speaker A talks → show A
Speaker B talks → show B
```

---

## Milestone 5

Integrate Qwen edit planning:

- edit-plan generation
- editorial angle
- clip improvement
- false starts
- intentional pause handling
- dynamic zoom

---

## Milestone 6

Explore advanced differentiation:

- story reconstruction
- reaction-aware editing
- non-contiguous clips
- personalized editing preferences

Do not start Milestone 6 until the core editing pipeline is reliable.

---

# Testing Requirements

Add or update tests.

Test at minimum:

### Timeline

- removals correctly remap timestamps
- captions remain synchronized
- visual events remain synchronized

### Cropping

- output crop remains inside source
- face remains inside safe frame
- target output ratio is correct

### Analysis

- valid face metadata
- silence boundaries
- filler timestamps

### Edit Plans

- schema validation
- invalid operations rejected
- overlapping removals normalized

### Renderer

- FFmpeg command generated correctly
- final dimensions correct
- audio remains synchronized
- final file is playable

### Regression

Existing viral clip functionality must continue working.

---

# Development Rules

Do not:

- rewrite working modules unnecessarily
- introduce huge dependencies without justification
- duplicate existing utilities
- mix business logic with FFmpeg command construction
- put all video intelligence inside one prompt
- tightly couple Qwen responses directly to FFmpeg
- blindly remove silence
- blindly remove filler
- center crop when face metadata exists
- animate the camera every second
- add visual effects merely for visual noise
- change the existing design system arbitrarily
- break existing APIs without migration

Prefer:

```text
small changes
clear interfaces
typed structures
deterministic behavior
cacheable analysis
local-first processing
graceful fallback
testability
```

---

# Product Quality Standard

The finished output should NOT feel like:

> "AI found a timestamp, center-cropped it, and added captions."

It should feel closer to:

> "A human short-form editor reviewed the podcast, removed the awkward parts, chose the right framing, followed the active speaker, tightened the pacing, and produced a polished social clip."

However, avoid over-editing.

Good editing also means knowing when **not** to cut, zoom, switch, or remove a pause.

---

# Begin

Start by inspecting the repository.

Then report:

1. current architecture
2. existing viral-clipping pipeline
3. reusable components
4. technical gaps
5. proposed edit-plan architecture
6. exact files/modules that should change
7. milestone implementation order

After that, begin implementing Milestone 1 and continue incrementally.

Do not create a parallel replacement application.

Improve the existing one.
