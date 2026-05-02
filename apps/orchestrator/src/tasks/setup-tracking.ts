import { task } from '@trigger.dev/sdk/v3';

// T-7-005: lógica de configuração de tracking implementada na onda 2
export const setupTrackingTask = task({
  id: 'setup-tracking',
  run: async (payload: {
    page_id: string;
    launch_id: string;
    workspace_id: string;
  }) => {
    // implementação em T-7-005
    return { status: 'stub' as const };
  },
});
