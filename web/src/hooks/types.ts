/** Shared API types mirroring the FastAPI backend schemas (app/schemas.py). */

export type User = {
  id: string;
  name: string | null;
  email: string;
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
  created_at: string;
  /** Signed URL of the rendered file — only set once video_url exists. */
  signed_video_url: string | null;
  signed_thumbnail_url: string | null;
  /** A queued/running render job for this clip, if any. */
  render_job: Job | null;
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
  options: { orientation?: string; max_clips?: number } | null;
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
