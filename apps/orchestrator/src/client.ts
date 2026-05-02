import { TriggerClient } from '@trigger.dev/sdk';

// Cliente centralizado para uso do SDK Trigger.dev no orchestrator.
export const client = new TriggerClient({
  id: 'globaltracker',
});
