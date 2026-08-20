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
  video_url: string;
  thumbnail_url: string | null;
  created_at: string;
  signed_video_url: string | null;
  signed_thumbnail_url: string | null;
};

export type Job = {
  id: string;
  project_id: string;
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
  status: string;
  created_at: string;
  clips: Clip[];
  jobs: Job[];
};
