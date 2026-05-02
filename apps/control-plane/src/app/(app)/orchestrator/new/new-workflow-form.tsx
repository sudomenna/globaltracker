'use client';

// T-7-009 — Client Component form for triggering workflows

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type WorkflowType = 'deploy-lp' | 'provision-campaigns';
type Platform = 'meta' | 'google';

interface NewWorkflowFormProps {
  accessToken: string;
}

export function NewWorkflowForm({ accessToken }: NewWorkflowFormProps) {
  const router = useRouter();
  const [workflowType, setWorkflowType] = useState<WorkflowType>('deploy-lp');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // deploy-lp fields
  const [launchId, setLaunchId] = useState('');
  const [slug, setSlug] = useState('');
  const [domain, setDomain] = useState('');

  // provision-campaigns fields
  const [campaignLaunchId, setCampaignLaunchId] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>([]);

  function togglePlatform(platform: Platform) {
    setPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const baseUrl =
        process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

      let body: Record<string, unknown>;

      if (workflowType === 'deploy-lp') {
        body = {
          template: 'capture',
          launch_id: launchId,
          slug,
          ...(domain.trim() ? { domain: domain.trim() } : {}),
        };
      } else {
        if (platforms.length === 0) {
          setError('Selecione ao menos uma plataforma.');
          setLoading(false);
          return;
        }
        body = {
          launch_id: campaignLaunchId,
          platforms,
        };
      }

      const res = await fetch(
        `${baseUrl}/v1/orchestrator/workflows/${workflowType}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(err.error ?? `Erro ${res.status}`);
        return;
      }

      const data = (await res.json()) as { run_id: string };
      router.push(`/orchestrator/${data.run_id}`);
    } catch {
      setError('Erro de conexão');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configurar Workflow</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Workflow type selector */}
          <div className="space-y-1">
            <label htmlFor="workflow-type" className="text-sm font-medium">
              Tipo de workflow
            </label>
            <select
              id="workflow-type"
              value={workflowType}
              onChange={(e) => setWorkflowType(e.target.value as WorkflowType)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="deploy-lp">Deploy Landing Page (deploy-lp)</option>
              <option value="provision-campaigns">
                Provisionar Campanhas (provision-campaigns)
              </option>
            </select>
          </div>

          {/* deploy-lp fields */}
          {workflowType === 'deploy-lp' && (
            <>
              <div className="space-y-1">
                <label htmlFor="launch-id" className="text-sm font-medium">
                  Launch ID (UUID)
                </label>
                <input
                  id="launch-id"
                  type="text"
                  required
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={launchId}
                  onChange={(e) => setLaunchId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="slug" className="text-sm font-medium">
                  Slug
                </label>
                <input
                  id="slug"
                  type="text"
                  required
                  placeholder="meu-lancamento"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="domain" className="text-sm font-medium">
                  Domínio{' '}
                  <span className="text-muted-foreground font-normal">
                    (opcional)
                  </span>
                </label>
                <input
                  id="domain"
                  type="text"
                  placeholder="exemplo.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </>
          )}

          {/* provision-campaigns fields */}
          {workflowType === 'provision-campaigns' && (
            <>
              <div className="space-y-1">
                <label
                  htmlFor="campaign-launch-id"
                  className="text-sm font-medium"
                >
                  Launch ID (UUID)
                </label>
                <input
                  id="campaign-launch-id"
                  type="text"
                  required
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={campaignLaunchId}
                  onChange={(e) => setCampaignLaunchId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Plataformas</legend>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={platforms.includes('meta')}
                      onChange={() => togglePlatform('meta')}
                      className="rounded"
                    />
                    Meta
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={platforms.includes('google')}
                      onChange={() => togglePlatform('google')}
                      className="rounded"
                    />
                    Google
                  </label>
                </div>
              </fieldset>
            </>
          )}

          {/* Error message */}
          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={loading}>
            {loading ? 'Disparando...' : 'Disparar Workflow'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
