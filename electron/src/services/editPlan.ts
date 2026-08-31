/**
 * EditPlan v1 — canonical JSON for Electron smart editing.
 * Source of truth for capcut-lite editor: big-box preview + right props + horizontal thumbs.
 * Validated with zod, normalized (overlap removals → merge, crop clamp, evenDown).
 * Electron only — backend/web frozen.
 */
import { z } from "zod";

// ── enums ──
export const aspectRatioSchema = z.enum(["9:16", "4:5", "1:1", "16:9"]);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export const tightnessSchema = z.enum(["natural", "social", "aggressive"]);
export type Tightness = z.infer<typeof tightnessSchema>;

export const removalTypeSchema = z.enum(["filler", "dead_air", "false_start"]);
export type RemovalType = z.infer<typeof removalTypeSchema>;

export const layoutSchema = z.enum(["speaker_focus", "two_speaker", "wide", "split", "pip"]);
export type Layout = z.infer<typeof layoutSchema>;

export const cameraModeSchema = z.enum(["face", "free"]);
export type CameraMode = z.infer<typeof cameraModeSchema>;

// ── sub-schemas ──
const ratioFrameSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

const panSchema = z.object({
  from_x: z.number().min(0).max(1),
  to_x: z.number().min(0).max(1),
  easing: z.enum(["smooth", "linear", "ease_in", "ease_out"]).default("smooth"),
  duration: z.number().min(0).max(10),
});

const cameraSchema = z.object({
  mode: cameraModeSchema.default("face"),
  target_face_id: z.string().nullable().optional(),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.35),
  zoom: z.number().min(1).max(2).default(1),
  pan: panSchema.optional(),
});

const removalSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  type: removalTypeSchema,
  text: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const segmentSchema = z.object({
  id: z.string().min(1),
  source_start: z.number().min(0),
  source_end: z.number().min(0),
  label: z.string().default(""),
  speaker_id: z.string().nullable().optional(),
  layout: layoutSchema.default("speaker_focus"),
  camera: cameraSchema.optional(),
  ratio_frame: ratioFrameSchema.optional(),
  removals: z.array(removalSchema).default([]),
  // caption words are clip-relative after TimelineMapper — keep loose here
  caption_style_id: z.string().nullable().optional(),
});

const sourceSchema = z.object({
  project_id: z.string().min(1),
  video_id: z.string().optional(),
  duration: z.number().min(0),
  srcW: z.number().min(1).optional(),
  srcH: z.number().min(1).optional(),
});

const outputSchema = z.object({
  aspect_ratio: aspectRatioSchema.default("9:16"),
  tightness: tightnessSchema.default("social"),
  removeFiller: z.boolean().default(true),
  punchIn: z.boolean().default(false),
  blur: z.boolean().default(false),
  caption_style_id: z.string().nullable().default(null),
  story: z.boolean().default(false).optional(),
  reaction: z.boolean().default(false).optional(),
});

const visualEventSchema = z.object({
  time: z.number().min(0),
  type: z.enum(["speaker_switch", "punch_in", "react"]),
  target: z.string().optional(),
});

export const editPlanSchema = z.object({
  version: z.literal(1),
  source: sourceSchema,
  output: outputSchema,
  timeline: z.array(segmentSchema).default([]),
  // global removals (legacy, per-segment preferred)
  removals: z.array(removalSchema).default([]),
  visual_events: z.array(visualEventSchema).default([]),
  meta: z
    .object({
      angles: z
        .array(z.object({ type: z.string(), score: z.number().min(0).max(100) }))
        .optional(),
      reason_codes: z.array(z.string()).optional(),
    })
    .optional(),
});

export type EditPlan = z.infer<typeof editPlanSchema>;
export type EditPlanSegment = z.infer<typeof segmentSchema>;
export type EditPlanRemoval = z.infer<typeof removalSchema>;

// ── helpers ──
function evenDown(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function normalizeRemovals(removals: EditPlanRemoval[]): EditPlanRemoval[] {
  const valid = removals
    .filter((r) => r.end > r.start && r.start >= 0)
    .sort((a, b) => a.start - b.start);
  const merged: EditPlanRemoval[] = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      // keep most severe confidence if present
      if ((r.confidence ?? 0) > (last.confidence ?? 0)) last.confidence = r.confidence;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export function normalizeEditPlan(plan: EditPlan): EditPlan {
  const normalized: EditPlan = {
    ...plan,
    output: {
      ...plan.output,
      aspect_ratio: plan.output.aspect_ratio,
      tightness: plan.output.tightness,
    },
    removals: normalizeRemovals(plan.removals ?? []),
    timeline: (plan.timeline ?? []).map((seg) => ({
      ...seg,
      source_end: Math.max(seg.source_end, seg.source_start + 0.1),
      camera: seg.camera
        ? {
            ...seg.camera,
            x: clamp01(seg.camera.x ?? 0.5),
            y: clamp01(seg.camera.y ?? 0.35),
            zoom: Math.max(1, Math.min(2, seg.camera.zoom ?? 1)),
          }
        : undefined,
      ratio_frame: seg.ratio_frame
        ? {
            x: clamp01(seg.ratio_frame.x),
            y: clamp01(seg.ratio_frame.y),
            w: clamp01(seg.ratio_frame.w),
            h: clamp01(seg.ratio_frame.h),
          }
        : undefined,
      removals: normalizeRemovals(seg.removals ?? []),
    })),
    visual_events: [...(plan.visual_events ?? [])].sort((a, b) => a.time - b.time),
  };
  // Clamp ratio_frame w/h evenDown guard is renderer-side (outputDimensions),
  // but keep normalized w/h >0.05 to avoid degenerate crop.
  for (const seg of normalized.timeline) {
    if (seg.ratio_frame) {
      if (seg.ratio_frame.w < 0.05) seg.ratio_frame.w = 0.05;
      if (seg.ratio_frame.h < 0.05) seg.ratio_frame.h = 0.05;
    }
  }
  return normalized;
}

export function validateEditPlan(data: unknown): EditPlan {
  const parsed = editPlanSchema.parse(data);
  return normalizeEditPlan(parsed);
}

export function safeParseEditPlan(data: unknown): { ok: true; plan: EditPlan } | { ok: false; error: string } {
  const res = editPlanSchema.safeParse(data);
  if (!res.success) {
    return { ok: false, error: res.error.message };
  }
  return { ok: true, plan: normalizeEditPlan(res.data) };
}

export function createDefaultEditPlan(projectId: string, durationSec: number, srcW = 1920, srcH = 1080): EditPlan {
  return normalizeEditPlan({
    version: 1,
    source: { project_id: projectId, duration: durationSec, srcW, srcH },
    output: {
      aspect_ratio: "9:16",
      tightness: "social",
      removeFiller: true,
      punchIn: false,
      blur: false,
      caption_style_id: null,
    },
    timeline: [],
    removals: [],
    visual_events: [],
    meta: { reason_codes: [] },
  });
}

// EvenDown helper exported for renderer tests parity with client-render/renderer.ts:evenDown
export { evenDown };
