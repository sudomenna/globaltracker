import { z } from 'zod';

const onboardingStepBase = z.object({
  completed_at: z.string().datetime().optional(),
});

export const OnboardingStateSchema = z
  .object({
    started_at: z.string().datetime().optional(),
    completed_at: z.string().datetime().nullable().optional(),
    skipped_at: z.string().datetime().nullable().optional(),
    step_meta: onboardingStepBase
      .extend({ validated: z.boolean().optional() })
      .optional(),
    step_ga4: onboardingStepBase
      .extend({ validated: z.boolean().optional() })
      .optional(),
    step_launch: onboardingStepBase
      .extend({ launch_id: z.string().uuid().optional() })
      .optional(),
    step_page: onboardingStepBase
      .extend({ page_id: z.string().uuid().optional() })
      .optional(),
    step_install: onboardingStepBase
      .extend({ first_ping_at: z.string().datetime().optional() })
      .optional(),
  })
  .strict();

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
