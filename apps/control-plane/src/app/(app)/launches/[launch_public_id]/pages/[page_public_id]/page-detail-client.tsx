'use client';

import { HealthBadge } from '@/components/health-badge';
import type { HealthState } from '@/components/health-badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { EventConfig } from '@/lib/page-role-defaults';
import {
  Check,
  ChevronLeft,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Save,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { DiagnosticsPanel } from './diagnostics-panel';

const CANONICAL_EVENT_OPTIONS = [
  'PageView',
  'Lead',
  'ViewContent',
  'InitiateCheckout',
  'Purchase',
  'Contact',
  'CompleteRegistration',
] as const;

interface PageStatus {
  page_public_id: string;
  health_state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  last_ping_at: string | null;
  events_today: number;
  events_last_24h: number;
  token_status: 'active' | 'rotating' | 'expired';
  token_rotates_at: string | null;
  recent_issues: Array<{
    type: string;
    domain?: string;
    count: number;
    last_seen_at: string;
  }>;
}

interface Props {
  launchPublicId: string;
  pagePublicId: string;
  accessToken: string;
  initialStatus: PageStatus | null;
  initialEventConfig?: EventConfig | null;
  initialUrl?: string | null;
  initialAllowedDomains?: string[];
  pageRole?: string | null;
}

const TRACKER_CDN_URL =
  process.env.NEXT_PUBLIC_TRACKER_CDN_URL ??
  'https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js';

function buildHeadSnippet(
  pageToken: string,
  pagePublicId: string,
  launchPublicId: string,
  edgeUrl?: string,
) {
  const edgeAttr = edgeUrl ? `\n  data-edge-url="${edgeUrl}"` : '';
  return `<script
  src="${TRACKER_CDN_URL}"
  data-site-token="${pageToken}"
  data-launch-public-id="${launchPublicId}"
  data-page-public-id="${pagePublicId}"${edgeAttr}
  async
></script>`;
}

function buildBodySnippet(formSelector: string) {
  return `<script>
document.addEventListener('DOMContentLoaded', function () {
  var form = document.querySelector('${formSelector}');
  if (!form) return;
  form.addEventListener('submit', function () {
    function val(sels) {
      for (var i = 0; i < sels.length; i++) {
        var el = form.querySelector(sels[i]);
        if (el && el.value) return el.value;
      }
    }
    window.Funil.identify({
      email: val(['[name="email"]', '[type="email"]', '[name="e-mail"]']),
      name: val(['[name="nome"]', '[name="name"]', '[name="primeiro_nome"]']),
      phone: val(['[name="telefone"]', '[name="celular"]', '[name="whatsapp"]', '[name="phone"]', '[name="fone"]']),
    });
  });
});
<\/script>`;
}

/**
 * Build a "detection script" the user pastes in DevTools console of their own
 * landing page. Inspects the form, maps inputs to identify fields, generates
 * the EXACT body snippet (with selectors that match the real DOM, using the
 * canonical capture flow: POST /v1/lead → localStorage → Funil.identify →
 * Funil.track('Lead')) and copies it to the clipboard.
 *
 * Funciona em LPs SPA (Framer, Next.js etc.) porque roda no DOM já renderizado.
 *
 * INV-TRACKER-008 / BR-TRACKER-001: Funil.identify só aceita {lead_token}.
 * Por isso o snippet gerado faz POST /v1/lead manualmente para obter o token.
 */
function buildDetectionScript(
  formSelector: string,
  edgeUrl: string,
  launchPublicId: string,
  pagePublicId: string,
  checkoutUrl: string,
) {
  return `// Cole no DevTools console da sua landing page (com o form já visível na tela).
// Detecta campos do form, gera o body snippet exato e copia pro clipboard.
(function () {
  var SELECTOR = ${JSON.stringify(formSelector)};
  var form = document.querySelector(SELECTOR);
  if (!form) {
    console.error('[gt] Form não encontrado para o seletor: ' + SELECTOR);
    return;
  }
  var REGEX = {
    email: /e[-_]?mail/i,
    name: /^(nome|name|first[-_]?name|primeiro[-_]?nome|full[-_]?name|nome[-_]?completo)$/i,
    phone: /telefone|celular|whatsapp|wpp|phone|fone|tel/i,
  };
  var detected = {};
  var inputs = form.querySelectorAll('input, select, textarea');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    var n = (el.name || '').trim();
    if (!n) continue;
    for (var key in REGEX) {
      if (REGEX[key].test(n) && !detected[key]) {
        detected[key] = n;
        break;
      }
    }
  }
  var keys = Object.keys(detected);
  if (keys.length === 0) {
    console.warn('[gt] Nenhum campo (email/name/phone) detectado no form. Inputs encontrados:', Array.from(inputs).map(function(x){return x.name;}).filter(Boolean));
    return;
  }
  var EDGE_URL = ${JSON.stringify(edgeUrl)};
  var LAUNCH = ${JSON.stringify(launchPublicId)};
  var PAGE = ${JSON.stringify(pagePublicId)};
  var CHECKOUT_URL = ${JSON.stringify(checkoutUrl ?? '')};
  var fieldReads = keys.map(function (k) {
    var attrSel = '[name="' + detected[k].replace(/"/g, '\\\\"') + '"]';
    return "      var " + k + "El = form.querySelector(" + JSON.stringify(attrSel) + ");\\n" +
           "      var " + k + "Val = " + k + "El && " + k + "El.value ? " + k + "El.value.trim() : '';";
  }).join('\\n');
  var bodyFields = keys.map(function (k) { return "        " + k + ": " + k + "Val"; }).join(',\\n');
  var snippet = '<script>\\n' +
    "(function(){\\n" +
    "  var EDGE_URL = " + JSON.stringify(EDGE_URL) + ";\\n" +
    "  var LAUNCH_PUBLIC_ID = " + JSON.stringify(LAUNCH) + ";\\n" +
    "  var PAGE_PUBLIC_ID = " + JSON.stringify(PAGE) + ";\\n" +
    "  var FORM_SELECTOR = " + JSON.stringify(SELECTOR) + ";\\n" +
    "  var CHECKOUT_URL = " + JSON.stringify(CHECKOUT_URL) + ";\\n" +
    "  var UTM_KEYS = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid'];\\n" +
    "  function pickUtms(){\\n" +
    "    try { var qs = new URLSearchParams(location.search); var p = new URLSearchParams();\\n" +
    "      UTM_KEYS.forEach(function(k){ var v = qs.get(k); if (v) p.set(k, v); });\\n" +
    "      return p; } catch(e){ return new URLSearchParams(); }\\n" +
    "  }\\n" +
    "  function appendQuery(url, extra){\\n" +
    "    if (!extra || !extra.toString || !extra.toString()) return url;\\n" +
    "    var sep = url.indexOf('?') >= 0 ? '&' : '?';\\n" +
    "    return url + sep + extra.toString();\\n" +
    "  }\\n" +
    "  var firing = false;\\n" +
    "  // Lê o page_token do <script data-site-token> do head (mesmo do tracker.js).\\n" +
    "  function getSiteToken(){\\n" +
    "    var tag = document.querySelector('script[data-site-token]');\\n" +
    "    return tag ? tag.getAttribute('data-site-token') : '';\\n" +
    "  }\\n" +
    "  function withTracker(cb){\\n" +
    "    if (window.Funil) { try { cb(window.Funil); } catch(e){} return; }\\n" +
    "    var n = 0, t = setInterval(function(){\\n" +
    "      if (window.Funil) { clearInterval(t); try { cb(window.Funil); } catch(e){} }\\n" +
    "      else if (++n >= 40) clearInterval(t);\\n" +
    "    }, 50);\\n" +
    "  }\\n" +
    "  function wire(){\\n" +
    "    var form = document.querySelector(FORM_SELECTOR);\\n" +
    "    if (!form) return;\\n" +
    "    form.addEventListener('submit', function(ev){\\n" +
    "      if (firing) return;\\n" +
    fieldReads + '\\n' +
    "      ev.preventDefault();\\n" +
    "      firing = true;\\n" +
    "      setTimeout(function(){ firing = false; }, 3000);\\n" +
    "      var siteToken = getSiteToken();\\n" +
    "      if (!siteToken) { console.warn('[gt] data-site-token ausente — confira o snippet do <head>'); return; }\\n" +
    "      var eventId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));\\n" +
    "      fetch(EDGE_URL + '/v1/lead', {\\n" +
    "        method: 'POST',\\n" +
    "        headers: { 'Content-Type': 'application/json', 'X-Funil-Site': siteToken },\\n" +
    "        credentials: 'include',\\n" +
    "        body: JSON.stringify({\\n" +
    "          event_id: eventId,\\n" +
    "          schema_version: 1,\\n" +
    "          launch_public_id: LAUNCH_PUBLIC_ID,\\n" +
    "          page_public_id: PAGE_PUBLIC_ID,\\n" +
    bodyFields + ',\\n' +
    "          attribution: {},\\n" +
    "          consent: { analytics: false, marketing: false, functional: true }\\n" +
    "        })\\n" +
    "      })\\n" +
    "      .then(function(r){ return r.ok ? r.json() : null; })\\n" +
    "      .then(function(resp){\\n" +
    "        if (resp && resp.lead_token) {\\n" +
    "          try { localStorage.setItem('__gt_ftk', resp.lead_token); } catch(e){}\\n" +
    "          withTracker(function(F){\\n" +
    "            F.identify({ lead_token: resp.lead_token });\\n" +
    "            F.track('Lead');\\n" +
    "          });\\n" +
    "        }\\n" +
    "      })\\n" +
    "      .catch(function(e){ console.warn('[gt] lead capture failed', e); })\\n" +
    "      .finally(function(){\\n" +
    "        setTimeout(function(){\\n" +
    "          if (CHECKOUT_URL) {\\n" +
    "            // Redirect explícito preservando UTMs da page atual.\\n" +
    "            window.location.href = appendQuery(CHECKOUT_URL, pickUtms());\\n" +
    "          } else if (form.requestSubmit) {\\n" +
    "            form.requestSubmit();\\n" +
    "          } else {\\n" +
    "            form.submit();\\n" +
    "          }\\n" +
    "        }, 80);\\n" +
    "      });\\n" +
    "    });\\n" +
    "  }\\n" +
    "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);\\n" +
    "  else wire();\\n" +
    "})();\\n" +
    '<\\/script>';
  console.log('[gt] Campos detectados:', detected);
  console.log('%c[gt] Snippet pronto:%c\\n' + snippet, 'color:#0a0;font-weight:bold', 'color:inherit');

  // Tenta copiar via Clipboard API; fallback execCommand se DevTools focado bloqueia.
  function copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }
  function done() {
    console.log('%c[gt] ✓ Copiado pro clipboard — cola antes de </body> no Framer.', 'color:#0a0;font-weight:bold');
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(snippet).then(done, function () {
      if (copyFallback(snippet)) done();
      else console.warn('[gt] Auto-copy falhou — copie o snippet acima manualmente (selecione e Cmd/Ctrl+C).');
    });
  } else if (copyFallback(snippet)) {
    done();
  } else {
    console.warn('[gt] Clipboard indisponível — copie o snippet acima manualmente.');
  }
})();`;
}

/**
 * Build a body snippet that wires arbitrary selectors to custom track() calls.
 * BR-EVENT-001: matching exato com prefixo `custom:` no processor.
 *
 * Aceita pares (event_name, selector). Sintaxes do selector:
 *   - CSS normal: `[data-gt="x"]`, `#id`, `.classe`, etc. (querySelector)
 *   - Texto:      `text:Quero Comprar` → match por textContent (case+trim insensitive)
 *
 * Útil em Framer/SPA onde adicionar custom attributes não é trivial.
 *
 * Gera 1 IIFE com listeners click `passive: true` + delegação no document
 * para o matcher por texto (cobre re-renders de SPA).
 */
function buildCustomEventsSnippet(
  pairs: Array<{ eventName: string; selector: string }>,
): string {
  const valid = pairs.filter((p) => p.eventName.trim() && p.selector.trim());
  if (valid.length === 0) {
    return '<!-- Preencha pelo menos 1 seletor abaixo para gerar o snippet -->';
  }
  const wires = valid
    .map((p) => {
      const sel = p.selector.trim();
      const evt = `custom:${p.eventName.trim()}`;
      if (sel.toLowerCase().startsWith('text:')) {
        const text = sel.slice(5).trim();
        return `    wireByText(${JSON.stringify(text)}, ${JSON.stringify(evt)});`;
      }
      return `    wireBySelector(${JSON.stringify(sel)}, ${JSON.stringify(evt)});`;
    })
    .join('\n');
  return `<script>
(function () {
  function withTracker(cb) {
    if (window.Funil) { try { cb(window.Funil); } catch (e) {} return; }
    var n = 0, t = setInterval(function () {
      if (window.Funil) { clearInterval(t); try { cb(window.Funil); } catch (e) {} }
      else if (++n >= 40) clearInterval(t);
    }, 50);
  }
  function fire(eventName) {
    withTracker(function (F) { F.track(eventName); });
  }
  function wireBySelector(selector, eventName) {
    var el = document.querySelector(selector);
    if (!el) return;
    el.addEventListener('click', function () { fire(eventName); }, { passive: true });
  }
  // Delegação no document — sobrevive a re-renders de SPA (Framer/Next/etc.).
  // Match: elemento clicado (ou ancestral até 5 níveis) com textContent normalizado igual ao alvo.
  function wireByText(targetText, eventName) {
    var target = (targetText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    if (!target) return;
    document.addEventListener('click', function (ev) {
      var node = ev.target;
      for (var i = 0; i < 5 && node && node !== document; i++) {
        var txt = (node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        if (txt === target) { fire(eventName); return; }
        node = node.parentNode;
      }
    }, { passive: true, capture: true });
  }
  function boot() {
${wires}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
<\/script>`;
}

const MASKED_TOKEN = '••••••••••••••••••••••';

const ROLES_WITHOUT_FORM = new Set(['checkout', 'thankyou']);

export function PageDetailClient({
  launchPublicId,
  pagePublicId,
  accessToken,
  initialStatus,
  initialEventConfig,
  initialUrl,
  initialAllowedDomains = [],
  pageRole,
}: Props) {
  const showFormSnippet = !ROLES_WITHOUT_FORM.has(pageRole ?? '');
  const [tokenVisible, setTokenVisible] = useState(false);
  // pageToken: lê do localStorage **após mount** para evitar hydration mismatch
  // (SSR retorna null, client tem valor → render diverge). Inicia null e
  // hidrata em useEffect.
  const [pageToken, setPageToken] = useState<string | null>(null);
  useEffect(() => {
    const v = localStorage.getItem(`gt:token:${pagePublicId}`);
    if (v) setPageToken(v);
  }, [pagePublicId]);
  const [copied, setCopied] = useState(false);
  const [bodyCopied, setBodyCopied] = useState(false);
  const [detectionCopied, setDetectionCopied] = useState(false);
  const [customEventsCopied, setCustomEventsCopied] = useState(false);
  const [formSelector, setFormSelector] = useState('form');
  const [checkoutUrl, setCheckoutUrl] = useState('');
  const [customEventSelectors, setCustomEventSelectors] = useState<
    Record<string, string>
  >({});
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [rotateConfirmInput, setRotateConfirmInput] = useState('');
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [eventConfig, setEventConfig] = useState<EventConfig>(() => ({
    canonical: initialEventConfig?.canonical ?? [],
    custom: initialEventConfig?.custom ?? [],
  }));
  const [customEventsText, setCustomEventsText] = useState(() =>
    (initialEventConfig?.custom ?? []).join('\n'),
  );
  const [isSavingEventConfig, setIsSavingEventConfig] = useState(false);
  const [eventConfigSaveError, setEventConfigSaveError] = useState<
    string | null
  >(null);
  const [eventConfigSaved, setEventConfigSaved] = useState(false);

  // Page configuration (url + allowed_domains)
  const [pageUrl, setPageUrl] = useState(initialUrl ?? '');
  const [allowedDomains, setAllowedDomains] = useState<string[]>(initialAllowedDomains);
  const [newDomain, setNewDomain] = useState('');
  const [isSavingPageConfig, setIsSavingPageConfig] = useState(false);
  const [pageConfigSaveError, setPageConfigSaveError] = useState<string | null>(null);
  const [pageConfigSaved, setPageConfigSaved] = useState(false);

  const statusLiveRegionRef = useRef<HTMLSpanElement>(null);
  const snippetSectionRef = useRef<HTMLDivElement>(null);

  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  const fetcher = useCallback(
    async (url: string) => {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Erro ao buscar status');
      return res.json() as Promise<PageStatus>;
    },
    [accessToken],
  );

  const hasPinged = initialStatus?.last_ping_at != null;
  // Aggressive polling until first ping; slow after that (docs/70-ux/09-interaction-patterns.md §polling)
  const [refreshInterval, setRefreshInterval] = useState(
    hasPinged ? 60_000 : 5_000,
  );

  const { data: status, error: statusError } = useSWR<PageStatus>(
    `${baseUrl}/v1/pages/${pagePublicId}/status`,
    fetcher,
    {
      fallbackData: initialStatus ?? undefined,
      refreshInterval,
      revalidateOnFocus: false,
    },
  );

  // Switch to slow polling once first ping arrives
  useEffect(() => {
    if (status?.last_ping_at != null && refreshInterval === 5_000) {
      setRefreshInterval(60_000);
      if (statusLiveRegionRef.current) {
        statusLiveRegionRef.current.textContent =
          'Tracker conectado e funcionando';
      }
    }
  }, [status?.last_ping_at, refreshInterval]);

  const connected = status?.last_ping_at != null;

  async function handleCopySnippet() {
    const token = pageToken ?? MASKED_TOKEN;
    const snippet = buildHeadSnippet(token, pagePublicId, launchPublicId, baseUrl);
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  async function handleRotateToken() {
    setIsRotating(true);
    setRotateError(null);

    const res = await fetch(
      `${baseUrl}/v1/pages/${pagePublicId}/rotate-token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    setIsRotating(false);

    if (!res.ok) {
      const errorId = res.headers.get('X-Request-Id') ?? 'desconhecido';
      setRotateError(`Falha ao rotacionar token. ID do erro: ${errorId}`);
      return;
    }

    const data = (await res.json()) as { page_token: string };
    setPageToken(data.page_token);
    localStorage.setItem(`gt:token:${pagePublicId}`, data.page_token);
    setTokenVisible(true);
    setRotateDialogOpen(false);
    setRotateConfirmInput('');
  }

  const rotateConfirmPhrase = `ROTACIONAR ${pagePublicId.toUpperCase()}`;
  const canConfirmRotate = rotateConfirmInput === rotateConfirmPhrase;

  function handleCanonicalToggle(eventName: string) {
    setEventConfig((prev) => {
      const has = prev.canonical.includes(eventName);
      return {
        ...prev,
        canonical: has
          ? prev.canonical.filter((e) => e !== eventName)
          : [...prev.canonical, eventName],
      };
    });
  }

  function handleCustomEventsChange(text: string) {
    setCustomEventsText(text);
    const custom = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith('custom:') ? line : `custom:${line}`));
    setEventConfig((prev) => ({ ...prev, custom }));
  }

  async function handleSaveEventConfig() {
    setIsSavingEventConfig(true);
    setEventConfigSaveError(null);
    setEventConfigSaved(false);

    const res = await fetch(`${baseUrl}/v1/pages/${pagePublicId}?launch_public_id=${launchPublicId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_config: eventConfig }),
    });

    setIsSavingEventConfig(false);

    if (!res.ok) {
      const errorId = res.headers.get('X-Request-Id') ?? 'desconhecido';
      setEventConfigSaveError(
        `Falha ao salvar configuração. ID do erro: ${errorId}`,
      );
      return;
    }

    setEventConfigSaved(true);
    setTimeout(() => setEventConfigSaved(false), 2_000);
  }

  function handleScrollToSnippet() {
    snippetSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  function handleAddDomain() {
    const domain = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain || allowedDomains.includes(domain)) return;
    setAllowedDomains((prev) => [...prev, domain]);
    setNewDomain('');
  }

  function handleRemoveDomain(domain: string) {
    setAllowedDomains((prev) => prev.filter((d) => d !== domain));
  }

  async function handleSavePageConfig() {
    setIsSavingPageConfig(true);
    setPageConfigSaveError(null);
    setPageConfigSaved(false);

    const body: Record<string, unknown> = { allowed_domains: allowedDomains };
    if (pageUrl.trim()) body.url = pageUrl.trim();
    else body.url = null;

    const res = await fetch(
      `${baseUrl}/v1/pages/${pagePublicId}?launch_public_id=${launchPublicId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    setIsSavingPageConfig(false);

    if (!res.ok) {
      const errorId = res.headers.get('X-Request-Id') ?? 'desconhecido';
      setPageConfigSaveError(`Falha ao salvar. ID do erro: ${errorId}`);
      return;
    }

    setPageConfigSaved(true);
    setTimeout(() => setPageConfigSaved(false), 2_000);
  }

  const displayToken = tokenVisible && pageToken ? pageToken : MASKED_TOKEN;
  const snippet = buildHeadSnippet(
    pageToken ?? MASKED_TOKEN,
    pagePublicId,
    launchPublicId,
    baseUrl,
  );

  const healthState: HealthState =
    status == null ? 'loading' : (status.health_state as HealthState);

  return (
    <div className="space-y-6 max-w-2xl">
      <Link
        href={`/launches/${launchPublicId}?tab=pages`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Voltar para o lançamento
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold font-mono">{pagePublicId}</h1>
            <p className="text-sm text-muted-foreground">
              Lançamento: {launchPublicId}
            </p>
          </div>
          <HealthBadge state={healthState} size="sm" />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRotateDialogOpen(true)}
          className="gap-1.5"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Rotacionar token
        </Button>
      </div>

      {/* Status card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status de instalação</CardTitle>
        </CardHeader>
        <CardContent>
          {status == null && !statusError && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-32" />
            </div>
          )}

          {statusError && (
            <p className="text-sm text-muted-foreground">
              Não foi possível verificar status — tentando novamente em 5s
            </p>
          )}

          {status != null && !statusError && (
            <div className="space-y-3">
              {/* Live region for screen readers — docs/70-ux/04-screen-page-registration.md §9 */}
              <span
                ref={statusLiveRegionRef}
                aria-live="polite"
                className="sr-only"
              />

              {!connected ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse"
                    aria-hidden="true"
                  />
                  Aguardando primeiro ping...
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Conectado
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Eventos hoje</span>
                  <p className="font-medium">{status.events_today}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Últimas 24h</span>
                  <p className="font-medium">{status.events_last_24h}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Token</span>
                  <p className="font-medium capitalize">
                    {status.token_status}
                  </p>
                </div>
                {status.token_rotates_at && (
                  <div>
                    <span className="text-muted-foreground">Rotaciona em</span>
                    <p className="font-medium">
                      {new Date(status.token_rotates_at).toLocaleDateString(
                        'pt-BR',
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Configuração da página */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuração da página</CardTitle>
          <CardDescription>
            URL da landing page e domínios autorizados a disparar eventos.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="page-url" className="text-sm font-medium">
              URL da página
            </label>
            <input
              id="page-url"
              type="url"
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
              placeholder="https://seudominio.com/captura"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Domínios autorizados</p>
            <p className="text-xs text-muted-foreground">
              Apenas requisições originadas desses domínios serão aceitas. Cole sem protocolo (ex:{' '}
              <code className="font-mono text-xs bg-muted px-1 rounded">cneeducacao.com</code>).
            </p>

            {allowedDomains.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allowedDomains.map((d) => (
                  <span
                    key={d}
                    className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs font-mono"
                  >
                    {d}
                    <button
                      type="button"
                      onClick={() => handleRemoveDomain(d)}
                      aria-label={`Remover domínio ${d}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddDomain(); } }}
                placeholder="cneeducacao.com"
                className="flex h-8 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddDomain}
                disabled={!newDomain.trim()}
              >
                Adicionar
              </Button>
            </div>
          </div>

          {pageConfigSaveError && (
            <p className="text-sm text-destructive">{pageConfigSaveError}</p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSavePageConfig}
            disabled={isSavingPageConfig}
            className="gap-1.5"
          >
            {pageConfigSaved ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Salvo!
              </>
            ) : (
              <>
                <Save className="h-4 w-4" aria-hidden="true" />
                {isSavingPageConfig ? 'Salvando...' : 'Salvar configuração'}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Diagnostics panel — A.4: contextual diagnosis for origin_not_allowed, invalid_token, no recent ping */}
      {status != null && (
        <DiagnosticsPanel
          issues={status.recent_issues}
          lastPingAt={status.last_ping_at}
          healthState={status.health_state}
          onScrollToSnippet={handleScrollToSnippet}
          onAddDomain={(domain) => {
            setAllowedDomains((prev) => prev.includes(domain) ? prev : [...prev, domain]);
          }}
        />
      )}

      {/* Snippet de instalação */}
      <Card id="snippet-section" ref={snippetSectionRef}>
        <CardHeader>
          <CardTitle className="text-base">Snippet de instalação</CardTitle>
          <CardDescription>
            Cole no{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">
              &lt;head&gt;
            </code>{' '}
            da landing page.
            {!pageToken && (
              <span className="block mt-1 text-amber-600 dark:text-amber-400">
                Token mascarado. Rotacione para obter um novo token em claro.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative rounded-md border bg-muted/50 p-3 font-mono text-xs overflow-x-auto">
            <pre className="whitespace-pre-wrap break-all">
              {buildHeadSnippet(displayToken, pagePublicId, launchPublicId, baseUrl)}
            </pre>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopySnippet}
              aria-label="Copiar snippet de instalação"
              className="gap-1.5"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Copiado!
                </>
              ) : (
                <>
                  <Clipboard className="h-4 w-4" aria-hidden="true" />
                  Copiar snippet
                </>
              )}
            </Button>

            {pageToken && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTokenVisible((v) => !v)}
                aria-label={tokenVisible ? 'Ocultar token' : 'Mostrar token'}
                className="gap-1.5"
              >
                {tokenVisible ? (
                  <>
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                    Ocultar
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4" aria-hidden="true" />
                    Mostrar
                  </>
                )}
              </Button>
            )}
          </div>

          {/* Token mascarado após primeiro ping — spec §3 */}
          {connected && !pageToken && (
            <p
              className="text-xs text-muted-foreground font-mono"
              aria-describedby="token-info"
            >
              Token atual: {MASKED_TOKEN}
            </p>
          )}
          {!pageToken && (
            <p id="token-info" className="text-xs text-muted-foreground">
              Para ver o token em claro, rotacione-o. O token antigo fica válido
              por 14 dias.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Snippet do body — captura de leads do formulário (oculto para checkout/thankyou) */}
      {showFormSnippet && <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Captura de leads do formulário
          </CardTitle>
          <CardDescription>
            Cole antes do{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">
              &lt;/body&gt;
            </code>{' '}
            da landing page. Ajuste o seletor se necessário.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label
              htmlFor="form-selector-detail"
              className="text-xs font-medium text-muted-foreground"
            >
              Seletor CSS do formulário
            </label>
            <input
              id="form-selector-detail"
              value={formSelector}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setFormSelector(e.target.value)
              }
              placeholder="form, #meu-form, .form-captura"
              className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="checkout-url-detail"
              className="text-xs font-medium text-muted-foreground"
            >
              URL do checkout (opcional)
            </label>
            <input
              id="checkout-url-detail"
              value={checkoutUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setCheckoutUrl(e.target.value)
              }
              placeholder="https://pay.guru.com.br/PRODUTO_ID"
              className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Se preenchido, após capturar o lead o snippet redireciona para esta URL anexando os UTMs (
              <code className="font-mono bg-muted px-1 rounded">utm_source/medium/campaign/content/term, fbclid, gclid</code>
              ) da page atual. Guru repropaga no payload do webhook de Purchase.
            </p>
          </div>

          <div className="relative rounded-md border bg-muted/50 p-3 font-mono text-xs overflow-x-auto">
            <pre className="whitespace-pre-wrap break-all">
              {buildBodySnippet(formSelector)}
            </pre>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              await navigator.clipboard.writeText(
                buildBodySnippet(formSelector),
              );
              setBodyCopied(true);
              setTimeout(() => setBodyCopied(false), 2_000);
            }}
            aria-label="Copiar script de captura de formulário"
            className="gap-1.5"
          >
            {bodyCopied ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Copiado!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copiar script (genérico)
              </>
            )}
          </Button>

          <div className="border-t pt-4 space-y-3">
            <div>
              <p className="text-sm font-medium">
                Gerar snippet exato a partir do form real
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                O genérico acima usa fallbacks de nomes comuns (email/nome/phone). Se
                seu form usa atributos <code className="font-mono bg-muted px-1 rounded">name=</code>{' '}
                fora do padrão (ex.: Framer com{' '}
                <code className="font-mono bg-muted px-1 rounded">Name</code>,{' '}
                <code className="font-mono bg-muted px-1 rounded">Phone</code>), use a detecção:
              </p>
              <ol className="text-xs text-muted-foreground mt-2 list-decimal list-inside space-y-0.5">
                <li>Abra sua landing page real no browser</li>
                <li>Abra o DevTools console (F12 → Console)</li>
                <li>Cole o script abaixo e tecle Enter</li>
                <li>O body snippet customizado vai pro seu clipboard</li>
                <li>Cole no Framer (antes de <code className="font-mono bg-muted px-1 rounded">&lt;/body&gt;</code>)</li>
              </ol>
            </div>

            <div className="relative rounded-md border bg-muted/50 p-3 font-mono text-xs overflow-x-auto max-h-64">
              <pre className="whitespace-pre-wrap break-all">
                {buildDetectionScript(formSelector, baseUrl, launchPublicId, pagePublicId, checkoutUrl)}
              </pre>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(
                  buildDetectionScript(formSelector, baseUrl, launchPublicId, pagePublicId, checkoutUrl),
                );
                setDetectionCopied(true);
                setTimeout(() => setDetectionCopied(false), 2_000);
              }}
              aria-label="Copiar script de detecção"
              className="gap-1.5"
            >
              {detectionCopied ? (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Copiado!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copiar script de detecção
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>}

      {/* Eventos customizados — wire de seletores DOM */}
      {eventConfig.custom.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Eventos customizados (clique em elementos)
            </CardTitle>
            <CardDescription>
              Para cada evento <code className="font-mono text-xs bg-muted px-1 rounded">custom:*</code>{' '}
              configurado nesta page, informe o seletor CSS do elemento que dispara
              o clique. O snippet gerado adiciona um listener para cada par
              (seletor, evento) e chama{' '}
              <code className="font-mono text-xs bg-muted px-1 rounded">Funil.track()</code> com o prefixo{' '}
              <code className="font-mono text-xs bg-muted px-1 rounded">custom:</code> exigido pelo processor (BR-EVENT-001).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              {eventConfig.custom.map((eventName) => (
                <div key={eventName} className="grid grid-cols-[1fr_2fr] gap-2 items-center">
                  <code className="font-mono text-xs bg-muted px-2 py-1 rounded truncate">
                    custom:{eventName}
                  </code>
                  <input
                    value={customEventSelectors[eventName] ?? ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setCustomEventSelectors((prev) => ({
                        ...prev,
                        [eventName]: e.target.value,
                      }))
                    }
                    placeholder={`[data-gt="${eventName}"]  OU  text:Quero Comprar`}
                    className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              ))}
            </div>

            <div className="relative rounded-md border bg-muted/50 p-3 font-mono text-xs overflow-x-auto max-h-64">
              <pre className="whitespace-pre-wrap break-all">
                {buildCustomEventsSnippet(
                  eventConfig.custom.map((name) => ({
                    eventName: name,
                    selector: customEventSelectors[name] ?? '',
                  })),
                )}
              </pre>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(
                  buildCustomEventsSnippet(
                    eventConfig.custom.map((name) => ({
                      eventName: name,
                      selector: customEventSelectors[name] ?? '',
                    })),
                  ),
                );
                setCustomEventsCopied(true);
                setTimeout(() => setCustomEventsCopied(false), 2_000);
              }}
              aria-label="Copiar snippet de eventos customizados"
              className="gap-1.5"
            >
              {customEventsCopied ? (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Copiado!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copiar snippet
                </>
              )}
            </Button>

            <p className="text-xs text-muted-foreground">
              <strong>Sintaxe aceita:</strong>
            </p>
            <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5 -mt-2">
              <li>
                CSS:{' '}
                <code className="font-mono bg-muted px-1 rounded">[data-gt="x"]</code>,{' '}
                <code className="font-mono bg-muted px-1 rounded">#id</code>,{' '}
                <code className="font-mono bg-muted px-1 rounded">.classe</code>
              </li>
              <li>
                Texto (recomendado em Framer/SPA sem custom attributes):{' '}
                <code className="font-mono bg-muted px-1 rounded">text:Quero Comprar</code>{' '}
                — bate por <code className="font-mono bg-muted px-1 rounded">textContent</code>{' '}
                (normalizado, case-insensitive), com delegação no{' '}
                <code className="font-mono bg-muted px-1 rounded">document</code> (sobrevive re-renders).
              </li>
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Configuração de eventos */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuração de eventos</CardTitle>
          <CardDescription>
            Selecione quais eventos canônicos esta página deve disparar e
            adicione eventos customizados se necessário.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="text-sm font-medium mb-2">
              Eventos canônicos
            </legend>
            <div className="space-y-2">
              {CANONICAL_EVENT_OPTIONS.map((eventName) => (
                <label
                  key={eventName}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={eventConfig.canonical.includes(eventName)}
                    onChange={() => handleCanonicalToggle(eventName)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm font-mono">{eventName}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <label
              htmlFor="custom-events-config"
              className="text-sm font-medium"
            >
              Eventos customizados{' '}
              <span className="font-normal text-muted-foreground">
                (opcional)
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Um evento por linha. O prefixo{' '}
              <code className="font-mono text-xs bg-muted px-1 rounded">
                custom:
              </code>{' '}
              é adicionado automaticamente.
            </p>
            <textarea
              id="custom-events-config"
              rows={3}
              value={customEventsText}
              onChange={(e) => handleCustomEventsChange(e.target.value)}
              placeholder="watched_class_1&#10;quiz_completed"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
            />
          </div>

          {eventConfigSaveError && (
            <p className="text-sm text-destructive">{eventConfigSaveError}</p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSaveEventConfig}
            disabled={isSavingEventConfig}
            className="gap-1.5"
          >
            {eventConfigSaved ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Salvo!
              </>
            ) : (
              <>
                <Save className="h-4 w-4" aria-hidden="true" />
                {isSavingEventConfig ? 'Salvando...' : 'Salvar configuração'}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* AlertDialog — confirmação destrutiva de rotação de token */}
      {/* Padrão §D de docs/70-ux/09-interaction-patterns.md */}
      <AlertDialog
        open={rotateDialogOpen}
        onOpenChange={(open) => {
          setRotateDialogOpen(open);
          if (!open) {
            setRotateConfirmInput('');
            setRotateError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Rotacionar token de rastreamento
            </AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação gera um <strong>novo token</strong>. O token atual entra
              em modo <em>rotating</em> e expira em <strong>14 dias</strong>.
              Você precisará atualizar o snippet em todas as páginas onde ele
              está instalado.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2 my-2">
            <p className="text-sm">
              Para confirmar, digite:{' '}
              <span className="font-mono font-medium">
                {rotateConfirmPhrase}
              </span>
            </p>
            <input
              type="text"
              value={rotateConfirmInput}
              onChange={(e) => setRotateConfirmInput(e.target.value)}
              placeholder={rotateConfirmPhrase}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`Digite ${rotateConfirmPhrase} para confirmar`}
            />
            {rotateError && (
              <p className="text-sm text-destructive">{rotateError}</p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRotateToken}
              disabled={!canConfirmRotate || isRotating}
            >
              {isRotating ? 'Rotacionando...' : 'Rotacionar token'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
