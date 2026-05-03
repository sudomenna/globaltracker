'use client';

import { TooltipHelp } from '@/components/tooltip-help';
import { Button } from '@/components/ui/button';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { OnboardingState } from './types';

const metaSchema = z.object({
  pixel_id: z
    .string()
    .min(1, 'Pixel ID obrigatório')
    .regex(/^\d{15,16}$/, 'Pixel ID deve ter 15 ou 16 dígitos numéricos'),
  capi_token: z.string().min(10, 'Token CAPI obrigatório'),
  test_event_code: z.string().optional(),
  confirm_domain: z.boolean().refine((v) => v === true, {
    message: 'Confirme a verificação de domínio',
  }),
  confirm_aem: z.boolean().refine((v) => v === true, {
    message: 'Confirme a priorização de eventos no AEM',
  }),
});

type MetaFormValues = z.infer<typeof metaSchema>;

interface StepMetaProps {
  state: OnboardingState['step_meta'];
  accessToken: string;
  onComplete: (data: OnboardingState['step_meta']) => void;
  onSkip: () => void;
}

export function StepMeta({
  state,
  accessToken,
  onComplete,
  onSkip,
}: StepMetaProps) {
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const form = useForm<MetaFormValues>({
    resolver: zodResolver(metaSchema),
    defaultValues: {
      pixel_id: state?.pixel_id ?? '',
      capi_token: '',
      test_event_code: '',
      confirm_domain: false,
      confirm_aem: false,
    },
    mode: 'onBlur',
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: MetaFormValues) {
    setValidationResult(null);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/integrations/meta/test`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            source: 'wizard',
            pixel_id: values.pixel_id,
            capi_token: values.capi_token,
            test_event_code: values.test_event_code || undefined,
          }),
        },
      );

      const body = (await res.json()) as {
        status?: string;
        error?: { code?: string; message?: string };
        code?: string;
      };

      if (res.ok && body.status === 'success') {
        setValidationResult({
          success: true,
          message:
            'Conexao validada — evento de teste chegou no Meta Events Manager.',
        });
        toast.success('Meta Pixel conectado com sucesso');
        onComplete({
          completed_at: new Date().toISOString(),
          pixel_id: values.pixel_id,
          validated: true,
        });
      } else {
        const errorCode = body.error?.code ?? body.code;
        const msg = getMetaErrorMessage(errorCode);
        setValidationResult({ success: false, message: msg });
      }
    } catch {
      setValidationResult({
        success: false,
        message: 'Erro ao conectar com o servidor. Tente novamente.',
      });
    }
  }

  async function handleSaveWithoutValidation() {
    const values = form.getValues();
    const pixelId = values.pixel_id;
    if (!pixelId || !/^\d{15,16}$/.test(pixelId)) {
      form.setError('pixel_id', {
        message: 'Pixel ID deve ter 15 ou 16 dígitos numéricos',
      });
      return;
    }
    toast.info('Configuracao salva sem validacao');
    onComplete({
      completed_at: new Date().toISOString(),
      pixel_id: pixelId,
      validated: false,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Conecte seu Meta Pixel</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Para enviar eventos de conversao para o Meta Ads.
        </p>
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 space-y-2">
        <p className="text-sm font-medium text-amber-900">
          Pre-requisito (faca no Meta antes de continuar)
        </p>
        <ol className="text-sm text-amber-800 space-y-1 list-decimal list-inside">
          <li>
            Verificar dominio da landing page no Meta Business Manager{' '}
            <a
              href="https://business.facebook.com/settings/owned-domains"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline"
              aria-label="Abrir verificacao de dominio no Meta (abre em nova aba)"
            >
              Abrir Domain Verification
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </li>
          <li>
            Configurar priorizacao de eventos no Aggregated Event Measurement{' '}
            <a
              href="https://business.facebook.com/events_manager2/list"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline"
              aria-label="Abrir Aggregated Event Measurement no Meta (abre em nova aba)"
            >
              Abrir AEM
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </li>
        </ol>
      </div>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="space-y-4"
      >
        <div className="space-y-1">
          <label htmlFor="pixel_id" className="text-sm font-medium">
            Pixel ID{' '}
            <TooltipHelp content="Encontrado em Meta Events Manager → seu Pixel → Configurações. Formato: 15-16 dígitos numéricos." />
          </label>
          <input
            id="pixel_id"
            type="text"
            inputMode="numeric"
            placeholder="123456789012345"
            autoComplete="off"
            aria-describedby={
              form.formState.errors.pixel_id ? 'pixel_id_error' : undefined
            }
            aria-invalid={!!form.formState.errors.pixel_id}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
            {...form.register('pixel_id')}
          />
          {form.formState.errors.pixel_id && (
            <p
              id="pixel_id_error"
              className="text-xs text-destructive"
              role="alert"
            >
              {form.formState.errors.pixel_id.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="capi_token" className="text-sm font-medium">
            Token CAPI{' '}
            <TooltipHelp content="Token de acesso da Conversions API. Gerado em Meta Events Manager → seu Pixel → Configurações → Conversions API." />{' '}
            <a
              href="https://www.facebook.com/business/help/397336587123030"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline inline-flex items-center gap-0.5"
              aria-label="Como gerar o Token CAPI (abre em nova aba)"
            >
              Como gerar?
              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
            </a>
          </label>
          <input
            id="capi_token"
            type="password"
            placeholder="EAAxxxxxx..."
            autoComplete="new-password"
            aria-describedby={
              form.formState.errors.capi_token ? 'capi_token_error' : undefined
            }
            aria-invalid={!!form.formState.errors.capi_token}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
            {...form.register('capi_token')}
          />
          {form.formState.errors.capi_token && (
            <p
              id="capi_token_error"
              className="text-xs text-destructive"
              role="alert"
            >
              {form.formState.errors.capi_token.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="test_event_code" className="text-sm font-medium">
            Test Event Code{' '}
            <span className="text-xs text-muted-foreground font-normal">
              (opcional)
            </span>
          </label>
          <input
            id="test_event_code"
            type="text"
            placeholder="TEST12345"
            autoComplete="off"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            {...form.register('test_event_code')}
          />
        </div>

        <div className="space-y-2 pt-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-input"
              aria-describedby={
                form.formState.errors.confirm_domain
                  ? 'confirm_domain_error'
                  : undefined
              }
              {...form.register('confirm_domain')}
            />
            <span className="text-sm">
              Confirmo que verifiquei o dominio no Meta Business Manager
            </span>
          </label>
          {form.formState.errors.confirm_domain && (
            <p
              id="confirm_domain_error"
              className="text-xs text-destructive ml-6"
              role="alert"
            >
              {form.formState.errors.confirm_domain.message}
            </p>
          )}

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-input"
              aria-describedby={
                form.formState.errors.confirm_aem
                  ? 'confirm_aem_error'
                  : undefined
              }
              {...form.register('confirm_aem')}
            />
            <span className="text-sm">
              Confirmo que priorizei eventos no AEM (iOS 14+)
            </span>
          </label>
          {form.formState.errors.confirm_aem && (
            <p
              id="confirm_aem_error"
              className="text-xs text-destructive ml-6"
              role="alert"
            >
              {form.formState.errors.confirm_aem.message}
            </p>
          )}
        </div>

        {validationResult && (
          <div
            role="alert"
            className={`flex items-start gap-2 rounded-md p-3 text-sm ${
              validationResult.success
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {validationResult.success ? (
              <CheckCircle2
                className="h-4 w-4 mt-0.5 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <AlertCircle
                className="h-4 w-4 mt-0.5 shrink-0"
                aria-hidden="true"
              />
            )}
            <span>{validationResult.message}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                Validando...
              </>
            ) : (
              'Salvar e validar'
            )}
          </Button>

          {validationResult && !validationResult.success && (
            <Button
              type="button"
              variant="outline"
              onClick={handleSaveWithoutValidation}
              disabled={isSubmitting}
            >
              Salvar mesmo assim
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function getMetaErrorMessage(errorCode?: string): string {
  const messages: Record<string, string> = {
    invalid_pixel_id:
      'Pixel ID invalido. Verifique se foi copiado corretamente do Meta Business Manager.',
    invalid_access_token:
      'Token CAPI invalido ou expirado. Tokens podem expirar ou ser revogados.',
    domain_not_verified:
      'Dominio nao verificado no Meta Business Manager. Verifique a configuracao.',
    event_dropped_due_to_acceptance_policy:
      'Meta descartou o evento (iOS 14+ AEM). Verifique priorizacao de eventos.',
    rate_limited:
      'Limite de requests do Meta atingido. Sistema vai retentar automaticamente.',
    meta_api_error:
      'Token CAPI invalido ou sem permissao para este Pixel. Verifique o token no Meta Events Manager.',
    integration_not_configured:
      'Pixel ID e Token CAPI sao obrigatorios para validar.',
    fetch_error:
      'Erro de rede ao conectar com o Meta. Verifique sua conexao.',
    validation_error:
      'Dados invalidos. Verifique o Pixel ID e o Token CAPI.',
  };
  return (
    messages[errorCode ?? ''] ?? 'Erro inesperado do Meta. Tente novamente.'
  );
}
