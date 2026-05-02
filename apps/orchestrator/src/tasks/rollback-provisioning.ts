import { task } from '@trigger.dev/sdk/v3';

// T-7-008: lógica de rollback de provisioning implementada na onda 3
export const rollbackProvisioningTask = task({
  id: 'rollback-provisioning',
  run: async (payload: {
    run_id: string;
    workspace_id: string;
    reason: string;
  }) => {
    // implementação em T-7-008
    return { status: 'stub' as const };
  },
});
