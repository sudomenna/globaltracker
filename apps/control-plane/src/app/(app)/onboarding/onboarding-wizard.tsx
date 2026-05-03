'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Check, ChevronLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { SkipAllDialog } from './skip-all-dialog';
import { StepGa4 } from './step-ga4';
import { StepInstall } from './step-install';
import { StepLaunch } from './step-launch';
import { StepMeta } from './step-meta';
import { StepPage } from './step-page';
import type { OnboardingState, StepKey } from './types';

const STEPS: { key: StepKey; label: string; shortLabel: string }[] = [
  { key: 'step_meta', label: 'Meta Pixel', shortLabel: 'Meta' },
  { key: 'step_ga4', label: 'Google Analytics 4', shortLabel: 'GA4' },
  { key: 'step_launch', label: 'Lancamento', shortLabel: 'Launch' },
  { key: 'step_page', label: 'Landing Page', shortLabel: 'Page' },
  { key: 'step_install', label: 'Instalar Tracker', shortLabel: 'Install' },
];

function isStepDone(state: OnboardingState, key: StepKey): boolean {
  return !!(state[key]?.completed_at || state[key]?.skipped);
}

function firstPendingStep(state: OnboardingState): number {
  const idx = STEPS.findIndex((s) => !isStepDone(state, s.key));
  return idx === -1 ? STEPS.length - 1 : idx;
}

interface OnboardingWizardProps {
  initialState: OnboardingState;
  accessToken: string;
}

export function OnboardingWizard({
  initialState,
  accessToken,
}: OnboardingWizardProps) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(initialState);
  const [currentStep, setCurrentStep] = useState(() =>
    firstPendingStep(initialState),
  );
  const [skipAllOpen, setSkipAllOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const isCompleted = !!state.completed_at;
  const isSkippedAll = !!state.skipped_at;

  const STEP_KEY_MAP = {
    step_meta: 'meta',
    step_ga4: 'ga4',
    step_launch: 'launch',
    step_page: 'page',
    step_install: 'install',
  } as const;

  async function persistStep(stepKey: StepKey, data: OnboardingState[StepKey]) {
    setIsSaving(true);
    try {
      const step = STEP_KEY_MAP[stepKey];
      const body: Record<string, unknown> = { step };

      if (data) {
        if ('completed_at' in data && data.completed_at)
          body.completed_at = data.completed_at;
        if ('skipped' in data && data.skipped)
          body.skipped = data.skipped;

        if (stepKey === 'step_meta' && 'validated' in data) {
          if (data.validated !== undefined) body.validated = data.validated;
          if ('pixel_id' in data && data.pixel_id) body.pixel_id = data.pixel_id;
          if ('capi_token' in data && data.capi_token) body.capi_token = data.capi_token;
        }
        if (stepKey === 'step_ga4' && 'validated' in data) {
          if (data.validated !== undefined) body.validated = data.validated;
          if ('measurement_id' in data && data.measurement_id)
            body.measurement_id = data.measurement_id;
          if ('api_secret' in data && data.api_secret) body.api_secret = data.api_secret;
        }
        if (stepKey === 'step_launch' && 'launch_public_id' in data && data.launch_public_id)
          body.launch_public_id = data.launch_public_id;
        if (stepKey === 'step_page') {
          if ('page_public_id' in data && data.page_public_id)
            body.page_public_id = data.page_public_id;
          if ('page_token' in data && data.page_token)
            body.page_token = data.page_token;
        }
        if (stepKey === 'step_install' && 'first_ping_at' in data && data.first_ping_at)
          body.first_ping_at = data.first_ping_at;
      }

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/onboarding/state`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        toast.error('Erro ao salvar progresso. Tente novamente.');
      }
    } catch {
      toast.error('Erro ao conectar com o servidor.');
    } finally {
      setIsSaving(false);
    }
  }

  async function persistCompleted() {
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/onboarding/state`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            step: 'complete',
            completed_at: new Date().toISOString(),
          }),
        },
      );
    } catch {
      // best-effort
    }
  }

  async function persistSkippedAll() {
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/onboarding/state`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            step: 'skip_all',
            skipped_at: new Date().toISOString(),
          }),
        },
      );
    } catch {
      // best-effort
    }
  }

  async function handleStepComplete(
    stepKey: StepKey,
    data: OnboardingState[StepKey],
  ) {
    const next = { ...state, [stepKey]: data };
    setState(next);
    await persistStep(stepKey, data);

    const nextIdx = currentStep + 1;
    if (nextIdx >= STEPS.length) {
      const withCompletion = {
        ...next,
        completed_at: new Date().toISOString(),
      };
      setState(withCompletion);
      await persistCompleted();
      toast.success('Onboarding concluido!');
    } else {
      setCurrentStep(nextIdx);
    }
  }

  async function handleStepSkip(stepKey: StepKey) {
    const data = { skipped: true } as OnboardingState[StepKey];
    const next = { ...state, [stepKey]: data };
    setState(next);
    await persistStep(stepKey, data);

    const nextIdx = currentStep + 1;
    if (nextIdx >= STEPS.length) {
      const withCompletion = {
        ...next,
        completed_at: new Date().toISOString(),
      };
      setState(withCompletion);
      await persistCompleted();
    } else {
      setCurrentStep(nextIdx);
    }
  }

  async function handleSkipAll() {
    const withSkip = { ...state, skipped_at: new Date().toISOString() };
    setState(withSkip);
    await persistSkippedAll();
    setSkipAllOpen(false);
    toast.info('Configuracao pulada. Voce pode retomar em Configuracoes.');
    router.push('/');
  }

  if (isCompleted) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 py-8">
        <div className="text-center space-y-2">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <Check className="h-6 w-6 text-green-600" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold">Workspace configurado!</h1>
          <p className="text-sm text-muted-foreground">
            Voce pode revisar ou reconfigurar qualquer integracao em{' '}
            <a href="/integrations" className="text-primary underline">
              Configuracoes
            </a>
            .
          </p>
        </div>
        <OnboardingStepsSummary state={state} onNavigate={setCurrentStep} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Bem-vindo ao GlobalTracker</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Vamos configurar seu workspace em 5 passos. Cada passo leva ~2
            minutos.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSkipAllOpen(true)}
          aria-label="Pular configuracao completa"
        >
          Pular
        </Button>
      </div>

      <WizardStepper
        currentStep={currentStep}
        state={state}
        onNavigate={setCurrentStep}
      />

      {isSaving && (
        <div
          className="text-xs text-muted-foreground text-right"
          aria-live="polite"
        >
          Salvando...
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          {currentStep === 0 && (
            <StepMeta
              state={state.step_meta}
              accessToken={accessToken}
              onComplete={(d) => handleStepComplete('step_meta', d)}
              onSkip={() => handleStepSkip('step_meta')}
            />
          )}
          {currentStep === 1 && (
            <StepGa4
              state={state.step_ga4}
              accessToken={accessToken}
              onComplete={(d) => handleStepComplete('step_ga4', d)}
              onSkip={() => handleStepSkip('step_ga4')}
            />
          )}
          {currentStep === 2 && (
            <StepLaunch
              state={state.step_launch}
              accessToken={accessToken}
              onComplete={(d) => handleStepComplete('step_launch', d)}
              onSkip={() => handleStepSkip('step_launch')}
            />
          )}
          {currentStep === 3 && (
            <StepPage
              state={state.step_page}
              launchPublicId={state.step_launch?.launch_public_id}
              accessToken={accessToken}
              onComplete={(d) => handleStepComplete('step_page', d)}
              onSkip={() => handleStepSkip('step_page')}
            />
          )}
          {currentStep === 4 && (
            <StepInstall
              state={state.step_install}
              pagePublicId={state.step_page?.page_public_id}
              pageToken={state.step_page?.page_token}
              launchPublicId={state.step_launch?.launch_public_id}
              accessToken={accessToken}
              onComplete={(d) => handleStepComplete('step_install', d)}
              onSkip={() => handleStepSkip('step_install')}
            />
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCurrentStep((s) => Math.max(0, s - 1))}
          disabled={currentStep === 0}
          aria-label="Voltar ao passo anterior"
        >
          <ChevronLeft className="h-4 w-4 mr-1" aria-hidden="true" />
          Voltar
        </Button>
      </div>

      <SkipAllDialog
        open={skipAllOpen}
        onCancel={() => setSkipAllOpen(false)}
        onConfirm={handleSkipAll}
      />
    </div>
  );
}

interface WizardStepperProps {
  currentStep: number;
  state: OnboardingState;
  onNavigate: (step: number) => void;
}

function WizardStepper({ currentStep, state, onNavigate }: WizardStepperProps) {
  return (
    <nav aria-label="Progresso do onboarding">
      <ol className="flex items-center gap-0">
        {STEPS.map((step, index) => {
          const done = isStepDone(state, step.key);
          const isActive = index === currentStep;
          const isPast = done || index < currentStep;

          return (
            <li
              key={step.key}
              className="flex items-center flex-1 last:flex-none"
            >
              <button
                type="button"
                onClick={() => onNavigate(index)}
                aria-label={`Passo ${index + 1} de ${STEPS.length}: ${step.label}${done ? ' — concluido' : isActive ? ' — atual' : ''}`}
                aria-current={isActive ? 'step' : undefined}
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : isActive
                      ? 'border-primary bg-background text-primary'
                      : 'border-muted-foreground/30 bg-background text-muted-foreground',
                )}
              >
                {done ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <span>{index + 1}</span>
                )}
              </button>
              {index < STEPS.length - 1 && (
                <div
                  className={cn(
                    'h-0.5 flex-1 transition-colors',
                    isPast && !isActive
                      ? 'bg-primary'
                      : 'bg-muted-foreground/20',
                  )}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-2 text-xs text-muted-foreground text-center">
        Passo {currentStep + 1} de {STEPS.length}:{' '}
        {STEPS[currentStep]?.label ?? ''}
      </div>
    </nav>
  );
}

interface OnboardingStepsSummaryProps {
  state: OnboardingState;
  onNavigate: (step: number) => void;
}

function OnboardingStepsSummary({
  state,
  onNavigate,
}: OnboardingStepsSummaryProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <ul className="space-y-3">
          {STEPS.map((step, index) => {
            const done = isStepDone(state, step.key);
            const skipped = state[step.key]?.skipped;
            return (
              <li key={step.key} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium border',
                      done && !skipped
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/30 text-muted-foreground',
                    )}
                    aria-hidden="true"
                  >
                    {done && !skipped ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <span className="text-sm">
                    [{index + 1}/5] {step.label}{' '}
                    {skipped ? (
                      <span className="text-muted-foreground text-xs">
                        — nao configurado
                      </span>
                    ) : done ? (
                      <span className="text-green-600 text-xs">
                        —{' '}
                        {step.key === 'step_launch'
                          ? state.step_launch?.launch_public_id
                          : step.key === 'step_page'
                            ? state.step_page?.page_public_id
                            : 'conectado'}
                      </span>
                    ) : null}
                  </span>
                </div>
                {(!done || skipped) && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => onNavigate(index)}
                    className="text-xs h-auto p-0"
                  >
                    Configurar agora
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

export function OnboardingWizardSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-48" />
      <div className="flex items-center gap-2">
        {(['meta', 'ga4', 'launch', 'page', 'install'] as const).map((k) => (
          <Skeleton key={k} className="h-8 w-8 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}
