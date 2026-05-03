'use client';

import { Button } from '@/components/ui/button';
import { Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { OnboardingState } from './types';

interface StepFormProps {
  state: OnboardingState['step_form'];
  onComplete: (data: OnboardingState['step_form']) => void;
  onSkip: () => void;
}

function buildFormSnippet(formSelector: string): string {
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

export function StepForm({ onComplete, onSkip }: StepFormProps) {
  const [hasForm, setHasForm] = useState<boolean | null>(null);
  const [selector, setSelector] = useState('form');
  const [copied, setCopied] = useState(false);

  const snippet = buildFormSnippet(selector);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
      toast.success('Script copiado');
    });
  }, [snippet]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Capturar leads do formulário</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Se sua LP tem um formulário de captura, instale o script abaixo para
          enviar email, nome e telefone ao GlobalTracker automaticamente.
        </p>
      </div>

      {hasForm === null && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Sua landing page tem um formulário de captura?</p>
          <div className="flex gap-2">
            <Button type="button" onClick={() => setHasForm(true)}>
              Sim
            </Button>
            <Button type="button" variant="outline" onClick={onSkip}>
              Não
            </Button>
          </div>
        </div>
      )}

      {hasForm === true && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="form-selector"
              className="text-sm font-medium"
            >
              Seletor CSS do seu formulário
            </label>
            <input
              id="form-selector"
              value={selector}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSelector(e.target.value)}
              placeholder="form, #meu-form, .form-captura"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Use o seletor CSS que identifica seu{' '}
              <code className="bg-muted px-1 rounded">&lt;form&gt;</code>. Se
              houver apenas um formulário na página, <code className="bg-muted px-1 rounded">form</code> já funciona.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">
              Cole este script antes do{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">&lt;/body&gt;</code>
            </p>
            <div className="relative">
              <pre
                aria-label="Script de captura de formulário"
                className="rounded-md bg-muted p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all border"
              >
                {snippet}
              </pre>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleCopy}
                aria-label="Copiar script de captura"
                className="absolute top-2 right-2 h-7 gap-1 text-xs"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                {copied ? 'Copiado!' : 'Copiar'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              O script tenta detectar os campos automaticamente por{' '}
              <code className="bg-muted px-1 rounded">name</code> e{' '}
              <code className="bg-muted px-1 rounded">type</code>. Se seus
              campos usarem outros nomes, ajuste os seletores no script.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => onComplete({ completed_at: new Date().toISOString() })}
            >
              Já instalei
            </Button>
            <Button type="button" variant="ghost" onClick={onSkip}>
              Pular
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
