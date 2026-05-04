'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronRight, Loader2, Plus, Rocket, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

// ─── Template presets ────────────────────────────────────────────────────────

const TEMPLATE_PRESETS = [
  {
    slug: 'lancamento_gratuito_3_aulas',
    name: 'Lançamento Gratuito (3 aulas)',
    description: 'Lead → WhatsApp → 3 aulas → Checkout → Compra',
    stages: 7,
    pages: 3,
    audiences: 4,
  },
  {
    slug: 'lancamento_pago_workshop_com_main_offer',
    name: 'Workshop Pago + Main Offer',
    description: 'Workshop pago com upsell para oferta principal',
    stages: 10,
    pages: 4,
    audiences: 5,
  },
  {
    slug: 'lancamento_pago_workshop_apenas',
    name: 'Workshop Pago (apenas)',
    description: 'Lançamento com workshop pago sem main offer',
    stages: 5,
    pages: 3,
    audiences: 3,
  },
  {
    slug: 'evergreen_direct_sale',
    name: 'Evergreen / Venda Direta',
    description: 'Funil simples: acesso → checkout → compra',
    stages: 2,
    pages: 3,
    audiences: 2,
  },
] as const;

type TemplateSlug = (typeof TEMPLATE_PRESETS)[number]['slug'];

// ─── Slugify ─────────────────────────────────────────────────────────────────

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

// ─── Launch types ─────────────────────────────────────────────────────────────

const LAUNCH_TYPES = [
  { value: 'lancamento_gratuito', label: 'Lançamento Gratuito' },
  { value: 'lancamento_pago', label: 'Lançamento Pago' },
  { value: 'evergreen', label: 'Evergreen' },
  { value: 'outro', label: 'Outro' },
] as const;

type LaunchType = (typeof LAUNCH_TYPES)[number]['value'];

const TYPE_LABELS: Record<LaunchType, string> = {
  lancamento_gratuito: 'Lançamento Gratuito',
  lancamento_pago: 'Lançamento Pago',
  evergreen: 'Evergreen',
  outro: 'Outro',
};

// ─── Zod schema ───────────────────────────────────────────────────────────────

const launchSchema = z
  .object({
    name: z.string().min(1, 'Nome obrigatorio').max(100),
    public_id: z
      .string()
      .min(3, 'Min 3 caracteres')
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'Apenas letras minusculas, numeros e hifens'),
    status: z.enum(['draft', 'configuring', 'live']),
    type: z
      .enum(['lancamento_gratuito', 'lancamento_pago', 'evergreen', 'outro'])
      .optional(),
    objective: z
      .string()
      .max(500, 'Maximo 500 caracteres')
      .optional()
      .or(z.literal('')),
    start_date: z.string().optional().or(z.literal('')),
    end_date: z.string().optional().or(z.literal('')),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return new Date(data.start_date) <= new Date(data.end_date);
      }
      return true;
    },
    {
      message: 'Data de início deve ser anterior ou igual à data de término',
      path: ['end_date'],
    },
  );

type LaunchFormValues = z.infer<typeof launchSchema>;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LaunchConfig {
  type?: LaunchType;
  objective?: string;
  timeline?: {
    start_date?: string;
    end_date?: string;
  };
}

interface Launch {
  name: string;
  public_id: string;
  status: string;
  created_at: string;
  config?: LaunchConfig;
}

// ─── Auth hook ────────────────────────────────────────────────────────────────

function useAccessToken(): string {
  const [token, setToken] = useState('');
  useEffect(() => {
    const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        let raw = match[1];
        if (raw?.startsWith('base64-')) {
          raw = atob(raw.slice(7));
        } else if (raw) {
          raw = decodeURIComponent(raw);
        }
        if (raw) {
          const parsed = JSON.parse(raw) as { access_token?: string };
          setToken(parsed?.access_token ?? '');
        }
      } catch {
        setToken('');
      }
    }
  }, []);
  return token;
}

// ─── Template selector (Step 0) ───────────────────────────────────────────────

function TemplateSelector({
  selected,
  onSelect,
  onContinue,
  onCancel,
}: {
  selected: TemplateSlug | null;
  onSelect: (slug: TemplateSlug | null) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Escolha um template para pré-configurar o funil, ou comece em branco.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Em branco */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`text-left rounded-lg border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            selected === null
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-muted-foreground/50'
          }`}
        >
          <p className="text-sm font-medium">Em branco</p>
          <p className="text-xs text-muted-foreground mt-1">
            Configure o funil manualmente
          </p>
          <p className="text-xs text-muted-foreground mt-2 opacity-0 select-none">
            ·
          </p>
        </button>

        {TEMPLATE_PRESETS.map((t) => (
          <button
            key={t.slug}
            type="button"
            onClick={() => onSelect(t.slug)}
            className={`text-left rounded-lg border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              selected === t.slug
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/50'
            }`}
          >
            <p className="text-sm font-medium">{t.name}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t.description}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {t.stages} stages · {t.pages} pages · {t.audiences} audiências
            </p>
          </button>
        ))}
      </div>

      <div className="flex gap-2 pt-2">
        <Button type="button" onClick={onContinue}>
          Continuar
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ─── Launch form (Step 1) ─────────────────────────────────────────────────────

function LaunchForm({
  onSuccess,
  onCancel,
  templateSlug,
}: {
  onSuccess: (launch: Launch) => void;
  onCancel: () => void;
  templateSlug?: TemplateSlug | null;
}) {
  const accessToken = useAccessToken();
  const form = useForm<LaunchFormValues>({
    resolver: zodResolver(launchSchema),
    defaultValues: {
      name: '',
      public_id: '',
      status: 'draft',
      type: undefined,
      objective: '',
      start_date: '',
      end_date: '',
    },
    mode: 'onBlur',
  });

  const nameValue = form.watch('name');
  const publicIdTouched = form.formState.dirtyFields.public_id;

  useEffect(() => {
    if (!publicIdTouched && nameValue) {
      form.setValue('public_id', slugify(nameValue), { shouldValidate: false });
    }
  }, [nameValue, publicIdTouched, form]);

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: LaunchFormValues) {
    try {
      const config: LaunchConfig = {};
      if (values.type) config.type = values.type;
      if (values.objective) config.objective = values.objective;
      if (values.start_date || values.end_date) {
        config.timeline = {};
        if (values.start_date) config.timeline.start_date = values.start_date;
        if (values.end_date) config.timeline.end_date = values.end_date;
      }

      const payload: Record<string, unknown> = {
        name: values.name,
        public_id: values.public_id,
        status: values.status,
      };
      if (Object.keys(config).length > 0) {
        payload.config = config;
      }
      if (templateSlug) {
        payload.funnel_template_slug = templateSlug;
      }

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/launches`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(payload),
        },
      );

      if (res.ok) {
        const body = (await res.json()) as {
          launch_public_id?: string;
          public_id?: string;
        };
        toast.success(`Lancamento "${values.name}" criado`);
        onSuccess({
          name: values.name,
          public_id:
            body.launch_public_id ?? body.public_id ?? values.public_id,
          status: values.status,
          created_at: new Date().toISOString(),
          config: Object.keys(config).length > 0 ? config : undefined,
        });
      } else {
        const body = (await res.json()) as { message?: string };
        toast.error(
          body.message ?? 'Erro ao criar lancamento. Tente novamente.',
        );
      }
    } catch {
      toast.error('Erro ao conectar com o servidor. Tente novamente.');
    }
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      noValidate
      className="space-y-4"
    >
      {templateSlug && (
        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          Template:{' '}
          <span className="font-medium text-foreground">
            {TEMPLATE_PRESETS.find((t) => t.slug === templateSlug)?.name ??
              templateSlug}
          </span>
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="launch_name" className="text-sm font-medium">
          Nome
        </label>
        <input
          id="launch_name"
          type="text"
          placeholder="Lancamento Maio 2026"
          aria-invalid={!!form.formState.errors.name}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive"
          {...form.register('name')}
        />
        {form.formState.errors.name && (
          <p className="text-xs text-destructive" role="alert">
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
          aria-invalid={!!form.formState.errors.public_id}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive"
          {...form.register('public_id')}
        />
        {form.formState.errors.public_id && (
          <p className="text-xs text-destructive" role="alert">
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

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">
          Tipo{' '}
          <span className="text-xs text-muted-foreground font-normal">
            (opcional)
          </span>
        </legend>
        <div className="flex flex-wrap gap-3">
          {LAUNCH_TYPES.map((t) => (
            <label
              key={t.value}
              className="flex items-center gap-1.5 cursor-pointer text-sm"
            >
              <input
                type="radio"
                value={t.value}
                className="h-4 w-4"
                {...form.register('type')}
              />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1">
        <label htmlFor="launch_objective" className="text-sm font-medium">
          Objetivo{' '}
          <span className="text-xs text-muted-foreground font-normal">
            (opcional)
          </span>
        </label>
        <textarea
          id="launch_objective"
          rows={3}
          maxLength={500}
          placeholder="Descreva o objetivo deste lançamento..."
          aria-invalid={!!form.formState.errors.objective}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive resize-none"
          {...form.register('objective')}
        />
        {form.formState.errors.objective && (
          <p className="text-xs text-destructive" role="alert">
            {form.formState.errors.objective.message}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="launch_start_date" className="text-sm font-medium">
            Data de início{' '}
            <span className="text-xs text-muted-foreground font-normal">
              (opcional)
            </span>
          </label>
          <input
            id="launch_start_date"
            type="date"
            aria-invalid={!!form.formState.errors.start_date}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive"
            {...form.register('start_date')}
          />
          {form.formState.errors.start_date && (
            <p className="text-xs text-destructive" role="alert">
              {form.formState.errors.start_date.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label htmlFor="launch_end_date" className="text-sm font-medium">
            Data de término{' '}
            <span className="text-xs text-muted-foreground font-normal">
              (opcional)
            </span>
          </label>
          <input
            id="launch_end_date"
            type="date"
            aria-invalid={!!form.formState.errors.end_date}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive"
            {...form.register('end_date')}
          />
          {form.formState.errors.end_date && (
            <p className="text-xs text-destructive" role="alert">
              {form.formState.errors.end_date.message}
            </p>
          )}
        </div>
      </div>

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
            'Criar lancamento'
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}

// ─── Status labels/colors ─────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  draft: 'Rascunho',
  configuring: 'Configurando',
  live: 'Ao vivo',
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-muted-foreground bg-muted',
  configuring: 'text-amber-700 bg-amber-100',
  live: 'text-green-700 bg-green-100',
};

// ─── Page ─────────────────────────────────────────────────────────────────────

type DialogStep = 'template' | 'form';

export default function LaunchesPage() {
  const [showForm, setShowForm] = useState(false);
  const [dialogStep, setDialogStep] = useState<DialogStep>('template');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSlug | null>(
    null,
  );
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [loading, setLoading] = useState(true);
  const accessToken = useAccessToken();

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/launches`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { launches?: Launch[] };
        if (!cancelled) setLaunches(body.launches ?? []);
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  function handleSuccess(launch: Launch) {
    setLaunches((prev) => [launch, ...prev]);
    setShowForm(false);
  }

  function openDialog() {
    setDialogStep('template');
    setSelectedTemplate(null);
    setShowForm(true);
  }

  function closeDialog() {
    setShowForm(false);
    setDialogStep('template');
    setSelectedTemplate(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Lançamentos</h1>
          <p className="text-sm text-muted-foreground">
            Gerencie seus lançamentos
          </p>
        </div>
        <Button onClick={openDialog}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          Novo lançamento
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lista de Lançamentos</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Carregando...
            </div>
          ) : launches.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Rocket
                className="h-8 w-8 text-muted-foreground/50"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                Nenhum lançamento cadastrado ainda.
              </p>
              <Button variant="outline" size="sm" onClick={openDialog}>
                <Plus className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Criar primeiro lançamento
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {launches.map((l) => (
                <li key={l.public_id}>
                  <Link
                    href={`/launches/${l.public_id}`}
                    className="flex items-center justify-between py-3 -mx-2 px-2 rounded-md hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{l.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {l.public_id}
                        </p>
                      </div>
                      {l.config?.type && (
                        <Badge variant="secondary" className="shrink-0 text-xs">
                          {TYPE_LABELS[l.config.type] ?? l.config.type}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[l.status] ?? ''}`}
                      >
                        {STATUS_LABELS[l.status] ?? l.status}
                      </span>
                      <ChevronRight
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Modal */}
      {showForm && (
        <dialog
          open
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm m-0 p-0 w-full h-full max-w-none max-h-none border-0"
          aria-labelledby="new-launch-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeDialog();
          }}
        >
          <div className="relative w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg max-h-[90vh] overflow-y-auto">
            <button
              type="button"
              onClick={closeDialog}
              className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Fechar"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="mb-4">
              <h2 id="new-launch-title" className="text-lg font-semibold">
                Novo lançamento
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {dialogStep === 'template'
                  ? 'Passo 1 de 2 — Escolha um template de funil'
                  : 'Passo 2 de 2 — Configure o lançamento'}
              </p>
            </div>

            {dialogStep === 'template' ? (
              <TemplateSelector
                selected={selectedTemplate}
                onSelect={setSelectedTemplate}
                onContinue={() => setDialogStep('form')}
                onCancel={closeDialog}
              />
            ) : (
              <LaunchForm
                onSuccess={handleSuccess}
                onCancel={closeDialog}
                templateSlug={selectedTemplate}
              />
            )}
          </div>
        </dialog>
      )}
    </div>
  );
}
