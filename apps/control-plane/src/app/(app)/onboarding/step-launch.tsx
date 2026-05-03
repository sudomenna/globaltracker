'use client';

import { Button } from '@/components/ui/button';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { OnboardingState } from './types';

const launchSchema = z.object({
  name: z.string().min(1, 'Nome obrigatorio').max(100),
  public_id: z
    .string()
    .min(3, 'Public ID obrigatorio (min 3 caracteres)')
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Apenas letras minusculas, numeros e hifens'),
  status: z.enum(['draft', 'configuring', 'live']),
});

type LaunchFormValues = z.infer<typeof launchSchema>;

type ExistingLaunch = {
  public_id: string;
  name: string;
  status: string;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

const BASE_URL =
  process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

interface StepLaunchProps {
  state: OnboardingState['step_launch'];
  accessToken: string;
  onComplete: (data: OnboardingState['step_launch']) => void;
  onSkip: () => void;
}

export function StepLaunch({
  state,
  accessToken,
  onComplete,
  onSkip,
}: StepLaunchProps) {
  const [mode, setMode] = useState<'choose' | 'select' | 'create'>('choose');
  const [existingLaunches, setExistingLaunches] = useState<ExistingLaunch[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedPublicId, setSelectedPublicId] = useState<string>('');

  const form = useForm<LaunchFormValues>({
    resolver: zodResolver(launchSchema),
    defaultValues: { name: '', public_id: '', status: 'configuring' },
    mode: 'onBlur',
  });

  const nameValue = form.watch('name');
  const publicIdTouched = form.formState.dirtyFields.public_id;

  useEffect(() => {
    if (!publicIdTouched && nameValue) {
      form.setValue('public_id', slugify(nameValue), { shouldValidate: false });
    }
  }, [nameValue, publicIdTouched, form]);

  async function loadExistingLaunches() {
    setLoadingList(true);
    try {
      const res = await fetch(`${BASE_URL}/v1/launches`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const body = (await res.json()) as { launches?: ExistingLaunch[] };
        setExistingLaunches(body.launches ?? []);
      } else {
        toast.error('Nao foi possivel carregar lançamentos existentes.');
      }
    } catch {
      toast.error('Erro ao conectar com o servidor.');
    } finally {
      setLoadingList(false);
    }
  }

  function handleSelectMode() {
    setMode('select');
    void loadExistingLaunches();
  }

  function handleUseSelected() {
    if (!selectedPublicId) return;
    const launch = existingLaunches.find((l) => l.public_id === selectedPublicId);
    toast.success(`Lancamento "${launch?.name ?? selectedPublicId}" associado.`);
    onComplete({
      completed_at: new Date().toISOString(),
      launch_public_id: selectedPublicId,
    });
  }

  async function onSubmit(values: LaunchFormValues) {
    try {
      const res = await fetch(`${BASE_URL}/v1/launches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          name: values.name,
          public_id: values.public_id,
          status: values.status,
        }),
      });

      if (res.ok) {
        const body = (await res.json()) as {
          launch_public_id?: string;
          public_id?: string;
        };
        const launchPublicId =
          body.launch_public_id ?? body.public_id ?? values.public_id;
        toast.success(`Lancamento "${values.name}" criado`);
        onComplete({
          completed_at: new Date().toISOString(),
          launch_public_id: launchPublicId,
        });
      } else if (res.status === 409) {
        toast.error(
          `Public ID "${values.public_id}" ja existe. Use "Selecionar existente" ou escolha outro ID.`,
        );
      } else {
        const body = (await res.json()) as { message?: string };
        toast.error(body.message ?? 'Erro ao criar lancamento. Tente novamente.');
      }
    } catch {
      toast.error('Erro ao conectar com o servidor. Tente novamente.');
    }
  }

  if (state?.completed_at && state.launch_public_id) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Crie seu primeiro Lancamento</h2>
        <div className="rounded-md border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-green-800">
            Lancamento <strong>{state.launch_public_id}</strong> associado.
          </p>
        </div>
      </div>
    );
  }

  const isSubmitting = form.formState.isSubmitting;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Configure seu Lancamento</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Um Lancamento agrupa landing pages, links e audiencias de uma campanha.
        </p>
      </div>

      {/* Mode chooser */}
      {mode === 'choose' && (
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={handleSelectMode}
            className="rounded-lg border-2 border-input p-4 text-left hover:border-ring hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-sm font-medium">Selecionar existente</p>
            <p className="text-xs text-muted-foreground mt-1">
              Associar um lancamento ja criado
            </p>
          </button>
          <button
            type="button"
            onClick={() => setMode('create')}
            className="rounded-lg border-2 border-input p-4 text-left hover:border-ring hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-sm font-medium">Criar novo</p>
            <p className="text-xs text-muted-foreground mt-1">
              Configurar um lancamento do zero
            </p>
          </button>
        </div>
      )}

      {/* Select existing */}
      {mode === 'select' && (
        <div className="space-y-4">
          {loadingList ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Carregando lancamentos...
            </div>
          ) : existingLaunches.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum lancamento encontrado.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => setMode('create')}
              >
                Criar novo
              </button>
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Lancamentos disponiveis</legend>
              {existingLaunches.map((l) => (
                <label
                  key={l.public_id}
                  className="flex items-center gap-3 rounded-md border border-input p-3 cursor-pointer hover:bg-accent transition-colors has-[:checked]:border-ring has-[:checked]:bg-accent"
                >
                  <input
                    type="radio"
                    name="existing_launch"
                    value={l.public_id}
                    checked={selectedPublicId === l.public_id}
                    onChange={() => setSelectedPublicId(l.public_id)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{l.name}</span>
                    <span className="block text-xs text-muted-foreground font-mono">{l.public_id}</span>
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground capitalize shrink-0">
                    {l.status}
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              onClick={handleUseSelected}
              disabled={!selectedPublicId}
            >
              Usar este lancamento
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode('choose')}>
              Voltar
            </Button>
          </div>
        </div>
      )}

      {/* Create new */}
      {mode === 'create' && (
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
          className="space-y-4"
        >
          <div className="space-y-1">
            <label htmlFor="launch_name" className="text-sm font-medium">
              Nome
            </label>
            <input
              id="launch_name"
              type="text"
              placeholder="Lancamento Maio 2026"
              aria-describedby={
                form.formState.errors.name ? 'launch_name_error' : undefined
              }
              aria-invalid={!!form.formState.errors.name}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
              {...form.register('name')}
            />
            {form.formState.errors.name && (
              <p id="launch_name_error" className="text-xs text-destructive" role="alert">
                {form.formState.errors.name.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="launch_public_id" className="text-sm font-medium">
              Public ID{' '}
              <span className="text-xs text-muted-foreground font-normal">
                (gerado automaticamente; editavel)
              </span>
            </label>
            <input
              id="launch_public_id"
              type="text"
              placeholder="lcm-maio-2026"
              autoComplete="off"
              aria-describedby={
                form.formState.errors.public_id
                  ? 'launch_public_id_error'
                  : undefined
              }
              aria-invalid={!!form.formState.errors.public_id}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
              {...form.register('public_id')}
            />
            {form.formState.errors.public_id && (
              <p
                id="launch_public_id_error"
                className="text-xs text-destructive"
                role="alert"
              >
                {form.formState.errors.public_id.message}
              </p>
            )}
          </div>

          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Status</legend>
            <div className="flex gap-4">
              {(['draft', 'configuring', 'live'] as const).map((s) => (
                <label
                  key={s}
                  className="flex items-center gap-1.5 cursor-pointer text-sm capitalize"
                >
                  <input
                    type="radio"
                    value={s}
                    className="h-4 w-4"
                    {...form.register('status')}
                  />
                  {s}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Criando...
                </>
              ) : (
                'Criar lancamento'
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setMode('choose')}
              disabled={isSubmitting}
            >
              Voltar
            </Button>
          </div>
        </form>
      )}

      {mode !== 'select' && (
        <div className="pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
            Pular este passo
          </Button>
        </div>
      )}
    </div>
  );
}
