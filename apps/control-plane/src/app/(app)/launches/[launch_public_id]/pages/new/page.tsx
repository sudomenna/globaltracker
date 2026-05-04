'use client';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  type EventConfig,
  PAGE_ROLES,
  PAGE_ROLE_DEFAULT_EVENT_CONFIG,
  type PageRole,
} from '@/lib/page-role-defaults';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, Plus, X } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

const newPageSchema = z.object({
  name: z
    .string()
    .min(1, 'Nome é obrigatório')
    .max(100, 'Máximo 100 caracteres'),
  allowed_domains: z
    .array(z.object({ value: z.string().min(1, 'Domínio é obrigatório') }))
    .min(1, 'Adicione ao menos um domínio'),
  tracking_mode: z.enum(['all_events', 'purchase_only']),
  role: z
    .enum(['capture', 'sales', 'checkout', 'thankyou', 'webinar', 'survey'])
    .optional(),
  custom_events: z.string().optional(),
});

type NewPageFormValues = z.infer<typeof newPageSchema>;

const PAGE_ROLE_LABELS: Record<PageRole, string> = {
  capture: 'Captura',
  sales: 'Vendas',
  checkout: 'Checkout',
  thankyou: 'Obrigado',
  webinar: 'Webinar',
  survey: 'Pesquisa',
};

export default function NewPagePage() {
  const params = useParams<{ launch_public_id: string }>();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [eventConfig, setEventConfig] = useState<EventConfig>({
    canonical: [],
    custom: [],
  });

  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewPageFormValues>({
    resolver: zodResolver(newPageSchema),
    defaultValues: {
      tracking_mode: 'all_events',
      allowed_domains: [{ value: '' }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'allowed_domains',
  });

  function handleRoleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const role = e.target.value as PageRole;
    if (role && PAGE_ROLE_DEFAULT_EVENT_CONFIG[role]) {
      setEventConfig(PAGE_ROLE_DEFAULT_EVENT_CONFIG[role]);
    } else {
      setEventConfig({ canonical: [], custom: [] });
    }
  }

  async function onSubmit(values: NewPageFormValues) {
    setServerError(null);

    const supabase = createSupabaseBrowser();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      router.push('/login');
      return;
    }

    // TODO: POST /v1/launches/:id/pages — endpoint not yet implemented (T-6-012)
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/launches/${params.launch_public_id}/pages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          name: values.name,
          allowed_domains: values.allowed_domains.map((d) => d.value),
          tracking_mode: values.tracking_mode,
          role: values.role ?? null,
          event_config: eventConfig,
          custom_events: values.custom_events
            ? values.custom_events
                .split('\n')
                .map((e) => e.trim())
                .filter(Boolean)
            : [],
        }),
      },
    );

    if (!response.ok) {
      const errorId = response.headers.get('X-Request-Id') ?? 'desconhecido';
      setServerError(
        `Falha ao criar página. ID do erro: ${errorId}. Tente novamente.`,
      );
      return;
    }

    const data = (await response.json()) as { page_public_id: string };
    router.push(
      `/launches/${params.launch_public_id}/pages/${data.page_public_id}`,
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Nova página</h1>
        <p className="text-sm text-muted-foreground">
          Configure o tracking para uma landing page
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
        {/* Identificação */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identificação</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium mb-1.5"
              >
                Nome
              </label>
              <input
                id="name"
                type="text"
                placeholder="Ex: Captura V1"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                {...register('name')}
              />
              {errors.name && (
                <p className="text-sm text-destructive mt-1.5">
                  {errors.name.message}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="role"
                className="block text-sm font-medium mb-1.5"
              >
                Tipo de página{' '}
                <span className="font-normal text-muted-foreground">
                  (opcional)
                </span>
              </label>
              <select
                id="role"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                {...register('role')}
                onChange={(e) => {
                  register('role').onChange(e);
                  handleRoleChange(e);
                }}
              >
                <option value="">Selecione um tipo...</option>
                {PAGE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {PAGE_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              {errors.role && (
                <p className="text-sm text-destructive mt-1.5">
                  {errors.role.message}
                </p>
              )}
              {eventConfig.canonical.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  Eventos pré-configurados:{' '}
                  <span className="font-medium">
                    {eventConfig.canonical.join(', ')}
                  </span>
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Domínios permitidos */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Domínios permitidos</CardTitle>
            <CardDescription>
              Adicione todos os domínios onde a LP roda. O tracker rejeitará
              pings de domínios não listados.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {fields.map((field, index) => (
              <div key={field.id} className="flex gap-2">
                <input
                  type="text"
                  placeholder="lp.seudominio.com"
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  {...register(`allowed_domains.${index}.value`)}
                />
                {fields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(index)}
                    aria-label="Remover domínio"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}
            {errors.allowed_domains?.root && (
              <p className="text-sm text-destructive">
                {errors.allowed_domains.root.message}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ value: '' })}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Adicionar domínio
            </Button>
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <AlertCircle
                className="h-3.5 w-3.5 mt-0.5 shrink-0"
                aria-hidden="true"
              />
              O Meta exige verificação separada destes domínios no Business
              Manager.
            </p>
          </CardContent>
        </Card>

        {/* Modo de tracking */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Modo de tracking</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                value="all_events"
                className="mt-0.5"
                {...register('tracking_mode')}
              />
              <div>
                <span className="text-sm font-medium">
                  Todos os eventos (recomendado)
                </span>
                <p className="text-xs text-muted-foreground">
                  Captura PageView, Lead, InitiateCheckout e Purchase
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                value="purchase_only"
                className="mt-0.5"
                {...register('tracking_mode')}
              />
              <div>
                <span className="text-sm font-medium">Apenas compras</span>
                <p className="text-xs text-muted-foreground">
                  Captura somente eventos de Purchase via webhook
                </p>
              </div>
            </label>
          </CardContent>
        </Card>

        {/* Eventos customizados */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Eventos customizados{' '}
              <span className="font-normal text-muted-foreground text-sm">
                (opcional)
              </span>
            </CardTitle>
            <CardDescription>
              Um nome por linha. Ex: VideoPlay, QuizCompleto
            </CardDescription>
          </CardHeader>
          <CardContent>
            <textarea
              rows={3}
              placeholder="VideoPlay&#10;QuizCompleto"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
              {...register('custom_events')}
            />
          </CardContent>
        </Card>

        {serverError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertCircle
              className="h-4 w-4 mt-0.5 shrink-0"
              aria-hidden="true"
            />
            {serverError}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/launches/${params.launch_public_id}`)}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Criando...' : 'Criar página'}
          </Button>
        </div>
      </form>
    </div>
  );
}
