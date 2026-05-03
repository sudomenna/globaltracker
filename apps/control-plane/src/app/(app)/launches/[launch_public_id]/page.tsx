'use client';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Activity, ChevronLeft, FileText, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Launch {
  public_id: string;
  name: string;
  status: string;
  created_at: string;
}

interface Page {
  public_id: string;
  name: string;
  status: string;
  created_at: string;
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

function useAccessToken(): string {
  const [token, setToken] = useState('');
  useEffect(() => {
    const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        let raw = match[1];
        if (raw && raw.startsWith('base64-')) {
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

export default function LaunchDetailPage() {
  const params = useParams<{ launch_public_id: string }>();
  const launchPublicId = params.launch_public_id;
  const accessToken = useAccessToken();

  const [launch, setLaunch] = useState<Launch | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);

  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const [launchesRes, pagesRes] = await Promise.all([
          fetch(`${baseUrl}/v1/launches`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          fetch(
            `${baseUrl}/v1/pages?launch_public_id=${encodeURIComponent(launchPublicId)}`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          ),
        ]);
        if (launchesRes.ok) {
          const body = (await launchesRes.json()) as { launches?: Launch[] };
          const found = (body.launches ?? []).find(
            (l) => l.public_id === launchPublicId,
          );
          if (!cancelled) setLaunch(found ?? null);
        }
        if (pagesRes.ok) {
          const body = (await pagesRes.json()) as { pages?: Page[] };
          if (!cancelled) setPages(body.pages ?? []);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, baseUrl, launchPublicId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-12">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Carregando...
      </div>
    );
  }

  if (!launch) {
    return (
      <div className="space-y-4">
        <Link
          href="/launches"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Voltar para lançamentos
        </Link>
        <p className="text-sm text-muted-foreground">Lançamento não encontrado.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/launches"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Voltar para lançamentos
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{launch.name}</h1>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[launch.status] ?? ''}`}
            >
              {STATUS_LABELS[launch.status] ?? launch.status}
            </span>
          </div>
          <p className="text-sm text-muted-foreground font-mono mt-1">
            {launch.public_id}
          </p>
        </div>
        <Button asChild>
          <Link href={`/launches/${launchPublicId}/events/live`}>
            <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
            Eventos ao vivo
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Landing pages</CardTitle>
            <CardDescription>Páginas associadas a este lançamento</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/launches/${launchPublicId}/pages/new`}>
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Nova página
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {pages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <FileText className="h-6 w-6 text-muted-foreground/50" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Nenhuma página cadastrada.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {pages.map((p) => (
                <li key={p.public_id}>
                  <Link
                    href={`/launches/${launchPublicId}/pages/${p.public_id}`}
                    className="flex items-center justify-between py-3 -mx-2 px-2 rounded-md hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div>
                      <p className="text-sm font-medium font-mono">{p.public_id}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {p.status}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
