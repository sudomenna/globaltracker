import { task } from '@trigger.dev/sdk/v3';

// T-7-007: lógica de provisioning de campanhas implementada na onda 3
export const provisionCampaignsTask = task({
  id: 'provision-campaigns',
  run: async (payload: {
    launch_id: string;
    platforms: ('meta' | 'google')[];
    workspace_id: string;
    run_id: string;
  }) => {
    // implementação em T-7-007
    return { status: 'stub' as const };
  },
});
