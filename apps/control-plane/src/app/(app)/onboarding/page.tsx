import { edgeFetch } from '@/lib/api-client';
import { createSupabaseServer } from '@/lib/supabase-server';
import { OnboardingWizard } from './onboarding-wizard';
import type { OnboardingState } from './types';

export default async function OnboardingPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token ?? '';

  let onboardingState: OnboardingState = {};

  try {
    const res = await edgeFetch('/v1/onboarding/state', accessToken);
    if (res.ok) {
      const json = (await res.json()) as { onboarding_state: OnboardingState };
      onboardingState = json.onboarding_state ?? {};
    }
  } catch {
    // Edge indisponível na inicialização — wizard inicia do zero
  }

  return (
    <OnboardingWizard
      initialState={onboardingState}
      accessToken={accessToken}
    />
  );
}
