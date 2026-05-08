'use client';

import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// Lifecycle stages — backend canonical (BR-IDENTITY: lifecycle_status)
export type Lifecycle = 'contato' | 'lead' | 'cliente' | 'aluno' | 'mentorado';

const LABEL: Record<Lifecycle, string> = {
  contato: 'Contato',
  lead: 'Lead',
  cliente: 'Cliente',
  aluno: 'Aluno',
  mentorado: 'Mentorado',
};

const TOOLTIP: Record<Lifecycle, string> = {
  contato: 'Cadastrado mas sem funil',
  lead: 'Em funil, sem compra',
  cliente: 'Comprou ebook, workshop ou webinar',
  aluno: 'Comprou curso, pós-graduação, treinamento ou evento',
  mentorado: 'Comprou mentoria ou acompanhamento',
};

interface LifecycleBadgeProps {
  lifecycle: Lifecycle;
  className?: string;
}

export function LifecycleBadge({ lifecycle, className }: LifecycleBadgeProps) {
  // contato → secondary, lead → default, cliente → success
  // aluno (roxo) e mentorado (dourado) usam className override pois Badge não tem essas variants
  let variant: 'default' | 'secondary' | 'success' | undefined;
  let extraClass = '';

  switch (lifecycle) {
    case 'contato':
      variant = 'secondary';
      break;
    case 'lead':
      variant = 'default';
      break;
    case 'cliente':
      variant = 'success';
      break;
    case 'aluno':
      extraClass = 'bg-purple-500 text-white border-transparent';
      break;
    case 'mentorado':
      extraClass = 'bg-amber-500 text-white border-transparent';
      break;
  }

  return (
    <Tooltip content={TOOLTIP[lifecycle]}>
      <Badge variant={variant} className={cn(extraClass, className)}>
        {LABEL[lifecycle]}
      </Badge>
    </Tooltip>
  );
}
