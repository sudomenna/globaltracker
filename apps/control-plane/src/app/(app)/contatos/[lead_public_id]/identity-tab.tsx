'use client';

/**
 * identity-tab.tsx — Sprint 17 / T-17-019
 *
 * Operator/Admin-only technical view of a lead's identity surface:
 *   - external matching hashes (SHA-256)
 *   - cookies / vendor identifiers
 *   - geo + device summary
 *
 * BR-PRIVACY-001: external hashes are visible only to operator/admin —
 * marketer sees a forbidden notice instead.
 * BR-RBAC: gating enforced client-side here AND server-side in /v1/leads/:id.
 *
 * Backend status: `/v1/leads/:public_id` (leads-summary route) currently
 * returns the redacted lead summary (display_name/email/phone, status,
 * lifecycle_status, timestamps). Hash columns and cookies are NOT exposed
 * yet — every block below renders `—` plus a TODO comment until the edge
 * route is extended (tracked under T-17-007 follow-ups).
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import useSWR from 'swr';

interface IdentityTabProps {
  leadPublicId: string;
  role: string;
}

// Best-effort shape of /v1/leads/:public_id — most identity fields are TODO.
interface LeadIdentityResponse {
  lead_public_id?: string;
  // TODO: backend não expõe esses campos ainda — fetch retorna `undefined`.
  email_hash_external?: string | null;
  phone_hash_external?: string | null;
  fn_hash?: string | null;
  ln_hash?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  fbp_last_seen_at?: string | null;
  fbc_last_seen_at?: string | null;
  ga_cookie?: string | null;
  client_id_ga4?: string | null;
  session_id_ga4?: string | null;
  ga_last_seen_at?: string | null;
  geo_city?: string | null;
  geo_region_code?: string | null;
  geo_country?: string | null;
  referrer?: string | null;
  ua_hash?: string | null;
}

function HashRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  hint: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [value]);

  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <Tooltip content={hint}>
          <span className="text-xs uppercase tracking-wide text-muted-foreground cursor-help">
            {label}
          </span>
        </Tooltip>
        <div className="font-mono text-xs break-all">
          {value ? value : <span className="text-muted-foreground">—</span>}
        </div>
      </div>
      {value && (
        <button
          type="button"
          onClick={() => void onCopy()}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label={`Copiar ${label}`}
        >
          <Copy className="h-3 w-3" />
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      )}
    </div>
  );
}

function FieldRow({
  label,
  value,
  meta,
}: {
  label: string;
  value: string | null | undefined;
  meta?: string | null;
}) {
  return (
    <div className="flex flex-col py-1.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-xs break-all">
        {value ? value : <span className="text-muted-foreground">—</span>}
      </span>
      {meta && (
        <span className="text-[10px] text-muted-foreground">{meta}</span>
      )}
    </div>
  );
}

export function IdentityTab({ leadPublicId, role }: IdentityTabProps) {
  // BR-RBAC: marketer never sees identity surface (hashes/cookies).
  if (role === 'marketer') {
    return (
      <p className="text-sm text-muted-foreground py-12 text-center">
        Esta aba está disponível apenas para Operator/Admin.
      </p>
    );
  }

  return <IdentityTabContent leadPublicId={leadPublicId} />;
}

function IdentityTabContent({ leadPublicId }: { leadPublicId: string }) {
  const { data, error, isLoading } = useSWR<LeadIdentityResponse>(
    `/v1/leads/${encodeURIComponent(leadPublicId)}`,
    async (url: string) => {
      const supabase = createSupabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';
      const res = await edgeFetch(url, token);
      if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
      return res.json() as Promise<LeadIdentityResponse>;
    },
  );

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-muted-foreground py-12 text-center">
        Não foi possível carregar dados de identidade.
      </p>
    );
  }

  const d = data ?? {};

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Hashes externos */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Hashes externos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {/* TODO: backend não expõe email_hash_external no GET /v1/leads/:id ainda */}
          <HashRow
            label="email_hash_external"
            value={d.email_hash_external ?? null}
            hint="SHA-256 puro — usado para matching com Meta/Google sem PII em claro."
          />
          {/* TODO: backend não expõe phone_hash_external ainda */}
          <HashRow
            label="phone_hash_external"
            value={d.phone_hash_external ?? null}
            hint="SHA-256 puro do telefone normalizado (E.164 sem prefixo)."
          />
          {/* TODO: backend não expõe fn_hash / ln_hash ainda */}
          <HashRow
            label="fn_hash"
            value={d.fn_hash ?? null}
            hint="SHA-256 puro do primeiro nome em lowercase."
          />
          <HashRow
            label="ln_hash"
            value={d.ln_hash ?? null}
            hint="SHA-256 puro do sobrenome em lowercase."
          />
        </CardContent>
      </Card>

      {/* Cookies */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Cookies / Identificadores</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {/* TODO: backend não expõe fbp/fbc/_ga/client_id_ga4/session_id_ga4 ainda */}
          <FieldRow
            label="fbp"
            value={d.fbp ?? null}
            meta={
              d.fbp_last_seen_at
                ? `visto em ${new Date(d.fbp_last_seen_at).toLocaleString('pt-BR')}`
                : undefined
            }
          />
          <FieldRow
            label="fbc"
            value={d.fbc ?? null}
            meta={
              d.fbc_last_seen_at
                ? `visto em ${new Date(d.fbc_last_seen_at).toLocaleString('pt-BR')}`
                : undefined
            }
          />
          <FieldRow label="_ga" value={d.ga_cookie ?? null} />
          <FieldRow
            label="client_id_ga4"
            value={d.client_id_ga4 ?? null}
            meta={
              d.ga_last_seen_at
                ? `visto em ${new Date(d.ga_last_seen_at).toLocaleString('pt-BR')}`
                : undefined
            }
          />
          <FieldRow label="session_id_ga4" value={d.session_id_ga4 ?? null} />
        </CardContent>
      </Card>

      {/* Geo + Device */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Geo + Device</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {/* TODO: backend não expõe geo_city/region/country/referrer/ua_hash ainda */}
          <FieldRow label="geo_city" value={d.geo_city ?? null} />
          <FieldRow label="geo_region_code" value={d.geo_region_code ?? null} />
          <FieldRow label="geo_country" value={d.geo_country ?? null} />
          <FieldRow label="referrer" value={d.referrer ?? null} />
          <FieldRow
            label="User Agent (hash)"
            value={d.ua_hash ?? null}
          />
        </CardContent>
      </Card>
    </div>
  );
}
