'use client';

import { Button } from '@/components/ui/button';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { OnboardingState } from './types';

const pageSchema = z.object({
  name: z.string().min(1, 'Nome obrigatorio').max(100),
  public_id: z
    .string()
    .min(3, 'Public ID obrigatorio (min 3 caracteres)')
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Apenas letras minusculas, numeros e hifens'),
  domains: z
    .array(z.object({ value: z.string().min(1, 'Dominio nao pode ser vazio') }))
    .min(1, 'Adicione pelo menos um dominio'),
  mode: z.enum(['b_snippet', 'server']),
  capture_pageview: z.boolean(),
  capture_lead: z.boolean(),
});

type PageFormValues = z.infer<typeof pageSchema>;

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

interface StepPageProps {
  state: OnboardingState['step_page'];
  launchPublicId?: string;
  accessToken: string;
  onComplete: (data: OnboardingState['step_page']) => void;
  onSkip: () => void;
}

export function StepPage({
  state,
  launchPublicId,
  accessToken,
  onComplete,
  onSkip,
}: StepPageProps) {
  // TODO T-6-0XX: trocar por POST /v1/pages quando endpoint estiver disponivel
  const form = useForm<PageFormValues>({
    resolver: zodResolver(pageSchema),
    defaultValues: {
      name: '',
      public_id: '',
      domains: [{ value: '' }],
      mode: 'b_snippet',
      capture_pageview: true,
      capture_lead: true,
    },
    mode: 'onBlur',
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'domains',
  });

  const nameValue = form.watch('name');
  const publicIdTouched = form.formState.dirtyFields.public_id;

  useEffect(() => {
    if (!publicIdTouched && nameValue) {
      form.setValue('public_id', slugify(nameValue), { shouldValidate: false });
    }
  }, [nameValue, publicIdTouched, form]);

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: PageFormValues) {
    try {
      // TODO T-6-0XX: POST /v1/pages
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/pages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            name: values.name,
            public_id: values.public_id,
            launch_public_id: launchPublicId,
            domains: values.domains.map((d) => d.value).filter(Boolean),
            mode: values.mode,
            capture_pageview: values.capture_pageview,
            capture_lead: values.capture_lead,
          }),
        },
      );

      if (res.ok) {
        const body = (await res.json()) as {
          page_public_id?: string;
          public_id?: string;
          page_token?: string;
        };
        const pagePublicId =
          body.page_public_id ?? body.public_id ?? values.public_id;
        toast.success(`Pagina "${values.name}" criada`);
        onComplete({
          completed_at: new Date().toISOString(),
          page_public_id: pagePublicId,
          page_token: body.page_token,
        });
      } else {
        const body = (await res.json()) as { message?: string };
        toast.error(body.message ?? 'Erro ao criar pagina. Tente novamente.');
      }
    } catch {
      toast.error('Erro ao conectar com o servidor. Tente novamente.');
    }
  }

  if (state?.completed_at && state.page_public_id) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Registre sua Landing Page</h2>
        <div className="rounded-md border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-green-800">
            Pagina <strong>{state.page_public_id}</strong> ja registrada.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Registre sua Landing Page</h2>
        {launchPublicId && (
          <p className="text-sm text-muted-foreground mt-1">
            Lancamento:{' '}
            <span className="font-mono text-xs">{launchPublicId}</span>
          </p>
        )}
      </div>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="space-y-4"
      >
        <div className="space-y-1">
          <label htmlFor="page_name" className="text-sm font-medium">
            Nome
          </label>
          <input
            id="page_name"
            type="text"
            placeholder="Captura V1"
            aria-describedby={
              form.formState.errors.name ? 'page_name_error' : undefined
            }
            aria-invalid={!!form.formState.errors.name}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
            {...form.register('name')}
          />
          {form.formState.errors.name && (
            <p
              id="page_name_error"
              className="text-xs text-destructive"
              role="alert"
            >
              {form.formState.errors.name.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="page_public_id" className="text-sm font-medium">
            Public ID{' '}
            <span className="text-xs text-muted-foreground font-normal">
              (gerado automaticamente; editavel)
            </span>
          </label>
          <input
            id="page_public_id"
            type="text"
            placeholder="captura-v1"
            aria-describedby={
              form.formState.errors.public_id
                ? 'page_public_id_error'
                : undefined
            }
            aria-invalid={!!form.formState.errors.public_id}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
            {...form.register('public_id')}
          />
          {form.formState.errors.public_id && (
            <p
              id="page_public_id_error"
              className="text-xs text-destructive"
              role="alert"
            >
              {form.formState.errors.public_id.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Dominios permitidos</p>
          {fields.map((field, index) => (
            <div key={field.id} className="flex gap-2">
              <input
                type="text"
                placeholder="lp.cliente.com"
                aria-label={`Dominio ${index + 1}`}
                aria-describedby={
                  form.formState.errors.domains?.[index]?.value
                    ? `domain_${index}_error`
                    : undefined
                }
                aria-invalid={!!form.formState.errors.domains?.[index]?.value}
                className="flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive"
                {...form.register(`domains.${index}.value`)}
              />
              {fields.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(index)}
                  aria-label={`Remover dominio ${index + 1}`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
              {form.formState.errors.domains?.[index]?.value && (
                <p
                  id={`domain_${index}_error`}
                  className="text-xs text-destructive mt-1"
                  role="alert"
                >
                  {form.formState.errors.domains[index]?.value?.message}
                </p>
              )}
            </div>
          ))}
          {form.formState.errors.domains?.root && (
            <p className="text-xs text-destructive" role="alert">
              {form.formState.errors.domains.root.message}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ value: '' })}
            className="gap-1"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Adicionar outro
          </Button>
        </div>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Modo</legend>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input
                type="radio"
                value="b_snippet"
                className="h-4 w-4"
                {...form.register('mode')}
              />
              Snippet (b_snippet)
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input
                type="radio"
                value="server"
                className="h-4 w-4"
                {...form.register('mode')}
              />
              Server-to-server
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Eventos a capturar</legend>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              {...form.register('capture_pageview')}
            />
            PageView (automatico ao carregar)
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              {...form.register('capture_lead')}
            />
            Lead (no submit do formulario)
          </label>
          <p className="text-xs text-muted-foreground">
            Custom — configurar depois
          </p>
        </fieldset>

        <div className="flex gap-2 pt-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                Criando...
              </>
            ) : (
              'Criar pagina'
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onSkip}
            disabled={isSubmitting}
          >
            Pular
          </Button>
        </div>
      </form>
    </div>
  );
}
