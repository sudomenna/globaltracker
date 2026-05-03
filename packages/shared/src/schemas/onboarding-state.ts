import { z } from 'zod';

const onboardingStepBase = z.object({
  completed_at: z.string().datetime().optional(),
  skipped: z.boolean().optional(),
});

export const OnboardingStateSchema = z
  .object({
    started_at: z.string().datetime().optional(),
    completed_at: z.string().datetime().nullable().optional(),
    skipped_at: z.string().datetime().nullable().optional(),
    step_meta: onboardingStepBase
      .extend({
        validated: z.boolean().optional(),
        pixel_id: z.string().optional(),
        capi_token: z.string().optional(),
      })
      .optional(),
    step_ga4: onboardingStepBase
      .extend({
        validated: z.boolean().optional(),
        measurement_id: z.string().optional(),
        api_secret: z.string().optional(),
      })
      .optional(),
    step_launch: onboardingStepBase
      .extend({ launch_public_id: z.string().optional() })
      .optional(),
    step_page: onboardingStepBase
      .extend({
        page_public_id: z.string().optional(),
        page_token: z.string().optional(),
      })
      .optional(),
    step_install: onboardingStepBase
      .extend({ first_ping_at: z.string().datetime().optional() })
      .optional(),
  })
  .strict();

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
