// Shared types for the onboarding wizard — T-6-011
// Mirrors packages/shared/src/schemas/onboarding-state.ts

export interface OnboardingState {
  step_meta?: {
    completed_at?: string;
    pixel_id?: string;
    capi_token?: string;
    skipped?: boolean;
    validated?: boolean;
  };
  step_ga4?: {
    completed_at?: string;
    measurement_id?: string;
    api_secret?: string;
    skipped?: boolean;
    validated?: boolean;
  };
  step_launch?: {
    completed_at?: string;
    launch_public_id?: string;
    skipped?: boolean;
  };
  step_page?: {
    completed_at?: string;
    page_public_id?: string;
    page_token?: string;
    skipped?: boolean;
  };
  step_install?: {
    completed_at?: string;
    first_ping_at?: string;
    skipped?: boolean;
  };
  step_form?: {
    completed_at?: string;
    skipped?: boolean;
  };
  completed_at?: string;
  skipped_at?: string;
  started_at?: string;
}

export type StepKey =
  | 'step_meta'
  | 'step_ga4'
  | 'step_launch'
  | 'step_page'
  | 'step_install'
  | 'step_form';

export interface PageStatus {
  page_public_id: string;
  health_state: 'pending' | 'healthy' | 'unhealthy';
  last_ping_at?: string;
  events_today?: number;
}
