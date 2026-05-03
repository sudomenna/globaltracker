'use client';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { OnboardingState } from './types';

const ga4Schema = z.object({
  measurement_id: z
    .string()
    .min(1, 'Measurement ID obrigatorio')
    .regex(/^G-[A-Z0-9]+$/, 'Formato esperado: G-XXXXXXXXXX'),
  api_secret: z.string().min(10, 'API Secret obrigatorio'),
  debug_mode: z.boolean(),
});

type Ga4FormValues = z.infer<typeof ga4Schema>;

interface StepGa4Props {
  state: OnboardingState['step_ga4'];
  accessToken: string;
  onComplete: (data: OnboardingState['step_ga4']) => void;
  onSkip: () => void;
}

export function StepGa4({
  state,
  accessToken,
  onComplete,
  onSkip,
}: StepGa4Props) {
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const form = useForm<Ga4FormValues>({
    resolver: zodResolver(ga4Schema),
    defaultValues: {
      measurement_id: state?.measurement_id ?? '',
      api_secret: '',
      debug_mode: true,
    },
    mode: 'onBlur',
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: Ga4FormValues) {
    setValidationResult(null);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/integrations/ga4/test`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            source: 'wizard',
            measurement_id: values.measurement_id,
            api_secret: values.api_secret,
            debug_mode: values.debug_mode,
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
          message: 'GA4 conectado com sucesso.',
        });
        toast.success('Google Analytics 4 configurado');
        onComplete({
          completed_at: new Date().toISOString(),
          measurement_id: values.measurement_id,
          validated: true,
        });
      } else {
        const errorCode = body.error?.code ?? body.code;
        const msg = getGa4ErrorMessage(errorCode);
        setValidationResult({ success: false, message: msg });
      }
    } catch {
      setValidationResult({
        success: false,
        message: 'Erro ao conectar com o servidor. Tente novamente.',
      });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">
          Conecte seu Google Analytics 4{' '}
          <span className="text-sm font-normal text-muted-foreground">
            (opcional)
          </span>
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Para enviar eventos analiticos ao GA4.
        </p>
      </div>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="space-y-4"
      >
        <div className="space-y-1">
          <label htmlFor="measurement_id" className="text-sm font-medium">
            Measurement ID{' '}
            <Tooltip content="Encontrado em GA4 > Admin > Streams de dados > seu stream. Formato: G-XXXXXXXXXX.">
              <span
                className="inline-flex items-center text-muted-foreground cursor-help"
                aria-label="Ajuda: Measurement ID"
                role="img"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </Tooltip>
          </label>
          <input
            id="measurement_id"
            type="text"
            placeholder="G-XXXXXXXXXX"
            autoComplete="off"
            aria-describedby={
              form.formState.errors.measurement_id
                ? 'measurement_id_error'
                : undefined
            }
            aria-invalid={!!form.formState.errors.measurement_id}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
            {...form.register('measurement_id')}
          />
          {form.formState.errors.measurement_id && (
            <p
              id="measurement_id_error"
              className="text-xs text-destructive"
              role="alert"
            >
              {form.formState.errors.measurement_id.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="ga4_api_secret" className="text-sm font-medium">
            API Secret{' '}
            <Tooltip content="Gerado em GA4 > Admin > Streams de dados > Measurement Protocol API secrets.">
              <span
                className="inline-flex items-center text-muted-foreground cursor-help"
                aria-label="Ajuda: API Secret GA4"
                role="img"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </Tooltip>{' '}
            <a
              href="https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#secret_value"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline inline-flex items-center gap-0.5"
              aria-label="Como gerar API Secret GA4 (abre em nova aba)"
            >
              Como gerar?
              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
            </a>
          </label>
          <input
            id="ga4_api_secret"
            type="password"
            placeholder="xxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="new-password"
            aria-describedby={
              form.formState.errors.api_secret
                ? 'ga4_api_secret_error'
                : undefined
            }
            aria-invalid={!!form.formState.errors.api_secret}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
            {...form.register('api_secret')}
          />
          {form.formState.errors.api_secret && (
            <p
              id="ga4_api_secret_error"
              className="text-xs text-destructive"
              role="alert"
            >
              {form.formState.errors.api_secret.message}
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            {...form.register('debug_mode')}
          />
          <span className="text-sm">
            Quero validar com debug_mode (recomendado)
          </span>
        </label>

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
          <Button
            type="button"
            variant="ghost"
            onClick={onSkip}
            disabled={isSubmitting}
          >
            Pular este passo
          </Button>
        </div>
      </form>
    </div>
  );
}

function getGa4ErrorMessage(errorCode?: string): string {
  const messages: Record<string, string> = {
    invalid_measurement_id:
      'Measurement ID invalido. Verifique se foi copiado corretamente do GA4.',
    invalid_api_secret:
      'API Secret invalido. Verifique ou gere um novo em GA4 > Admin > Streams de dados.',
    validation_failed:
      'Payload rejeitado pelo GA4. Verifique os parametros enviados.',
  };
  return messages[errorCode ?? ''] ?? 'Erro inesperado. Tente novamente.';
}
