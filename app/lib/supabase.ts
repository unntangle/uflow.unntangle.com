// ============================================================
// Supabase client (server-side only)
// ============================================================
// We use the SERVICE ROLE key because:
//   1. RLS is disabled on CRM tables (see schema.sql)
//   2. Auth is gated by our own signed-cookie session middleware
//   3. This client never runs in the browser
//
// The service role key bypasses RLS — it must NEVER be exposed
// to the client. That's why this file has no 'use client' and
// is imported only from server components and route handlers.
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { JobComplexity, JobCategory } from './job-options';

let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var. ' +
      'See app/crm/SETUP.md.'
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

// ============================================================
// Typed row shapes — keep in sync with schema.sql
// ============================================================
export type CrmUser = {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: '3d_artist' | 'admin' | 'client';
  client_id: string | null;
  created_at: string;
};

export type CrmClient = {
  id: string;
  slug: string;
  name: string;
  created_at: string;
};

export type ProjectStatus =
  | 'draft'
  | 'qa_pending'
  // IQA Rejected: admin rejected the artist's submission; the
  // artist will revise and resubmit. (Was just 'rejected' before
  // the IQA/EQA split.)
  | 'iqa_rejected'
  // EQA Rejected: client rejected during their final sign-off
  // review; back to admin to decide whether to forward to the
  // artist or push back on the client.
  | 'eqa_rejected'
  // The three WIP flavours. Functionally identical — they all
  // upload back to qa_pending — but they preserve context for
  // the admin's WIP tab so the status badge can render the
  // origin ("WIP" vs "IQA WIP" vs "EQA WIP"). Transition rules:
  //   draft        + Start  → wip
  //   iqa_rejected + Start  → iqa_wip
  //   eqa_rejected + Start  → eqa_wip
  | 'wip'
  | 'iqa_wip'
  | 'eqa_wip'
  // Admin has approved the model; waiting for the client's final
  // sign-off in /client/qa/[id]. Public viewer at
  // officemate.unntangle.com/<slug> does NOT show models in this
  // state — only 'approved' is published.
  | 'client_review'
  | 'approved';

// ============================================================
// Client-rejection feedback (separate table from artist feedback)
// ============================================================
// When a client rejects in /client/qa/[id], the rejection lives
// in uflow_client_feedback_images (not uflow_feedback_images),
// so the source of feedback is unambiguous at the data layer.
export type CrmClientFeedbackImage = {
  id: string;
  project_id: string;
  revision_number: number;
  image_url: string;
  uploaded_by: string;
  created_at: string;
};

export type CrmProject = {
  id: string;
  client_id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  zip_url: string | null;
  glb_url: string | null;
  fbx_url: string | null;
  gltf_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  // Classification set on the admin Create/Edit Job forms.
  // Nullable: rows predating the 2026-08-09 migration are
  // unclassified, and either field can be cleared back to that.
  // Allowed values live in lib/job-options.ts, enforced by the
  // CHECK constraints in that migration.
  complexity: JobComplexity | null;
  category: JobCategory | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CrmFeedbackImage = {
  id: string;
  project_id: string;
  revision: number;
  image_url: string;
  note: string | null;
  uploaded_by: string | null;
  created_at: string;
};

// Joined view used by the dashboards (project + its client)
export type ProjectWithClient = CrmProject & {
  client: Pick<CrmClient, 'slug' | 'name'>;
};

export type CrmProjectReference = {
  id: string;
  project_id: string;
  image_url: string;
  uploaded_by: string | null;
  created_at: string;
};
