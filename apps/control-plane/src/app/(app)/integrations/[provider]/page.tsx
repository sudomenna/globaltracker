import { HealthBadge } from '@/components/health-badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { createSupabaseServer } from '@/lib/supabase-server';
import { notFound } from 'next/navigation';
import { IntegrationDetailClient } from './integration-detail-client';

const PROVIDER_META: Record<
  string,
  {
    label: string;
    description: string;
    deepLinks: { label: string; href: string }[];
  }
> = {
  meta: {
    label: 'Meta CAPI',
    description:
      'Conversions API do Meta — envia eventos de servidor para o pixel sem depender do browser.',
    deepLinks: [
      {
        label: 'Events Manager',
        href: 'https://business.facebook.com/events_manager',
      },
      {
        label: 'Domain Verification',
        href: 'https://business.facebook.com/settings/owned-domains',
      },
      {
        label: 'Aggregated Event Measurement',
        href: 'https://business.facebook.com/events_manager2/list/pixel/',
      },
    ],
  },
  ga4: {
    label: 'Google Analytics 4',
    description:
      'Measurement Protocol GA4 — envia eventos de servidor diretamente para a propriedade GA4.',
    deepLinks: [
      {
        label: 'DebugView',
        href: 'https://analytics.google.com/analytics/web/',
      },
      {
        label: 'Realtime',
        href: 'https://analytics.google.com/analytics/web/',
      },
    ],
  },
  google_ads: {
    label: 'Google Ads Conversion',
    description:
      'Conversion Upload — envia conversões offline para o Google Ads via API.',
    deepLinks: [
      {
        label: 'Conversion Actions',
        href: 'https://ads.google.com/aw/conversions',
      },
    ],
  },
  google_ads_enhanced: {
    label: 'Google Enhanced Conversions',
    description:
      'Enhanced Conversions — melhora a correspondência de conversões com dados hasheados.',
    deepLinks: [
      {
        label: 'Conversion Actions',
        href: 'https://ads.google.com/aw/conversions',
      },
    ],
  },
};

interface PageProps {
  params: Promise<{ provider: string }>;
}

export default async function IntegrationDetailPage({ params }: PageProps) {
  const { provider } = await params;
  const meta = PROVIDER_META[provider];

  if (meta == null) {
    notFound();
  }

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const role = (user?.app_metadata?.role as string | undefined) ?? 'marketer';

  // AUTHZ: only operator/admin/owner may edit credentials
  const canEdit = ['operator', 'admin', 'owner'].includes(role);

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{meta.label}</h1>
          <p className="text-sm text-muted-foreground">{meta.description}</p>
        </div>
      </div>

      <IntegrationDetailClient
        provider={provider}
        providerLabel={meta.label}
        deepLinks={meta.deepLinks}
        canEdit={canEdit}
        role={role}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Últimas tentativas</CardTitle>
          <CardDescription>
            Histórico de dispatch para {meta.label}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-4 text-center">
            Sem tentativas registradas no período.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
