'use client';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronRight, Loader2, Plus, Rocket, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

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

const launchSchema = z.object({
  name: z.string().min(1, 'Nome obrigatorio').max(100),
  public_id: z
    .string()
    .min(3, 'Min 3 caracteres')
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Apenas letras minusculas, numeros e hifens'),
  status: z.enum(['draft', 'configuring', 'live']),
});

type LaunchFormValues = z.infer<typeof launchSchema>;

interface Launch {
  name: string;
  public_id: string;
  status: string;
  created_at: string;
}

function useAccessToken(): string {
  const [token, setToken] = useState('');
  useEffect(() => {
    const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        let raw = match[1];
        if (raw.startsWith('base64-')) {
          raw = atob(raw.slice(7));
        } else {
          raw = decodeURIComponent(raw);
        }
        const parsed = JSON.parse(raw) as { access_token?: string };
        setToken(parsed?.access_token ?? '');
      } catch {
        setToken('');
      }
    }
  }, []);
  return token;
}

function LaunchForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: (launch: Launch) => void;
  onCancel: () => void;
}) {
  const accessToken = useAccessToken();
  const form = useForm<LaunchFormValues>({
    resolver: zodResolver(launchSchema),
    defaultValues: { name: '', public_id: '', status: 'draft' },
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
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/launches`,
        {
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
          public_id: body.launch_public_id ?? body.public_id ?? values.public_id,
          status: values.status,
          created_at: new Date().toISOString(),
        });
      } else {
        const body = (await res.json()) as { message?: string };
        toast.error(body.message ?? 'Erro ao criar lancamento. Tente novamente.');
      }
    } catch {
      toast.error('Erro ao conectar com o servidor. Tente novamente.');
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
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
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

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

export default function LaunchesPage() {
  const [showForm, setShowForm] = useState(false);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Lançamentos</h1>
          <p className="text-sm text-muted-foreground">
            Gerencie seus lançamentos
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>
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
              <Rocket className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                Nenhum lançamento cadastrado ainda.
              </p>
              <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
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
                    <div>
                      <p className="text-sm font-medium">{l.name}</p>
                      <p className="text-xs text-muted-foreground font-mono">{l.public_id}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[l.status] ?? ''}`}
                      >
                        {STATUS_LABELS[l.status] ?? l.status}
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-launch-title"
          onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}
        >
          <div className="relative w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <button
              type="button"
              onClick={() => setShowForm(false)}
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
                Um lançamento agrupa landing pages, links e audiências de uma campanha.
              </p>
            </div>
            <LaunchForm
              onSuccess={handleSuccess}
              onCancel={() => setShowForm(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
