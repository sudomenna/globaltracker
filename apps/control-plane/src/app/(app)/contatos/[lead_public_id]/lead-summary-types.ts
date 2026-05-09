/**
 * Lead summary types — frontend mirror of the /v1/leads/:id/summary contract.
 *
 * Source of truth: apps/edge/src/lib/lead-summary.ts (LeadSummary type) and
 * apps/edge/src/routes/leads-summary.ts (leadSummaryResponseSchema).
 *
 * BR-PRIVACY-001: zero PII in this shape — only aggregates, UTMs, stages, tags,
 * consent flags. Safe to render to any authenticated workspace member.
 */

export type LeadSummaryUtm = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
};

export type LeadSummary = {
  current_stage: { stage: string; since: string } | null;
  stages_journey: Array<{ stage: string; at: string }>;
  tags: Array<{ tag_name: string; set_by: string; set_at: string }>;
  attribution_summary: {
    first_touch: LeadSummaryUtm | null;
    last_touch: LeadSummaryUtm | null;
    fbclid: string | null;
    gclid: string | null;
  };
  consent_current: {
    analytics: boolean;
    marketing: boolean;
    ad_user_data: boolean;
    ad_personalization: boolean;
    customer_match: boolean;
    updated_at: string;
  } | null;
  metrics: {
    events_total: number;
    dispatches_ok: number;
    dispatches_failed: number;
    dispatches_skipped: number;
    purchase_total_brl: number;
    last_activity_at: string | null;
  };
};
