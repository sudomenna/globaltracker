import { task } from '@trigger.dev/sdk/v3';

// T-7-006: lógica de deploy de landing page implementada na onda 2
export const deployLpTask = task({
  id: 'deploy-lp',
  run: async (payload: {
    template: string;
    launch_id: string;
    slug: string;
    domain?: string;
    workspace_id: string;
  }) => {
    // implementação em T-7-006
    return { status: 'stub' as const };
  },
});
