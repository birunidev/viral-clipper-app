/** Shared API types mirroring the FastAPI backend schemas (app/schemas.py). */

export type User = {
  id: string;
  name: string | null;
  email: string;
};

/** Per-user BYOK settings (GET response; keys are masked/write-only). */
export type UserSettings = {
  transcription_provider: "assemblyai" | "local";
  llm_base_url: string | null;
  llm_model: string | null;
  has_llm_api_key: boolean;
  llm_api_key_preview: string | null;
  has_assemblyai_key: boolean;
  assemblyai_key_preview: string | null;
  storage_used_bytes: number;
  storage_cap_bytes: number;
  storage_remaining_bytes: number;
};

export type CaptionWord = {
  text: string;
  start_ms: number;
  end_ms: number;
};

export type CaptionStyle = {
  id: string;
  key: string;
  label: string;
  config: Record<string, unknown>;
  is_builtin: boolean;
};

export type Clip = {
  id: string;
  title: string;
  viral_hook: string | null;
  start_time: number;
  end_time: number;
  /** Null until a render job has cut this clip. */
  video_url: string | null;
  thumbnail_url: string | null;
  /** Clip-relative word timings for word-by-word captions (may be null). */
  caption_json: CaptionWord[] | null;
  created_at: string;
  /** Signed URL of the rendered file — only set once video_url exists. */
  signed_video_url: string | null;
  signed_thumbnail_url: string | null;
  /** A queued/running render job for this clip, if any. */
  render_job: Job | null;
  /** Which caption style produced the current video_url, if any. */
  caption_style_id: string | null;
};

export type Job = {
  id: string;
  project_id: string;
  type: "analyze" | "render";
  clip_id: string | null;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  options: {
    orientation?: string;
    max_clips?: number;
    caption_style_id?: string;
  } | null;
  created_at: string;
  updated_at: string;
  project?: { id: string; title: string; status: string } | null;
};

export type ProjectListItem = {
  id: string;
  title: string;
  source: string;
  source_type: string;
  status: string;
  created_at: string;
  clip_count: number;
  latest_job: { id: string; status: string; progress: number } | null;
};

export type TrashProject = ProjectListItem & {
  deleted_at: string;
};

export type ProjectDetail = {
  id: string;
  title: string;
  source: string;
  source_type: string;
  source_key: string | null;
  status: string;
  created_at: string;
  /** Signed URL of the canonical source video — clips preview by seeking
   * this to [start_time, end_time], no rendering required. */
  source_video_url: string | null;
  clips: Clip[];
  jobs: Job[];
};

// ------------------------------------------------------------------ billing

export type EntitlementLimits = {
  storage_cap_bytes: number;
  max_projects: number | null;
  max_resolution: number | null;
  watermark: boolean;
};

/** A purchasable one-time credit pack (1 credit = 1 minute of source video). */
export type CreditPack = {
  key: string;
  name: string;
  credits: number;
  /** One-time Paddle (global) price in USD, e.g. 2.9. */
  price_usd: number;
  /** One-time Midtrans (Indonesia) price in whole rupiah. */
  price_idr: number;
  /** The permanent entitlement limits this pack unlocks when bought. */
  limits: EntitlementLimits;
};

/**
 * The user's credit balance, permanent entitlement tier + usage and the
 * available packs (GET /billing/status). There are no subscriptions.
 */
export type BillingStatus = {
  /** Highest credit pack ever purchased, or "free". Permanent. */
  tier: string;
  tier_name: string;
  /** Prepaid credit balance (1 = 1 source minute). */
  credits: number;
  /** Whether bring-your-own-key is exposed (feature flag). */
  byok_enabled: boolean;
  /** Server-side flag enabling browser (WebCodecs) clip rendering. */
  client_render: boolean;
  limits: EntitlementLimits;
  usage: {
    storage_used_bytes: number;
    storage_remaining_bytes: number;
    projects: number;
  };
  packs: CreditPack[];
};
