'use client';

import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

export interface TagChipProps {
  name: string;
  color?: string | null;
  /**
   * - 'default' — usa a cor da tag (se fornecida) ou cinza.
   * - 'has' — verde suave (lead possui a tag / filtro "possui" satisfeito).
   * - 'missing' — vermelho suave (lead NÃO possui / filtro "não tem" satisfeito).
   */
  variant?: 'default' | 'has' | 'missing';
  size?: 'sm' | 'md';
  removable?: boolean;
  onRemove?: () => void;
  /** Tooltip nativo (title attr) — útil para set_by/set_at em tag aplicada. */
  title?: string;
  className?: string;
}

// Hex parser + luminância simples (W3C relative-luminance approx).
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const v = m[1] as string;
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

function isDarkBg(hex: string): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return false;
  // 0..255 → relative luminance via fórmula sRGB simplificada
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum < 0.6;
}

export function TagChip({
  name,
  color,
  variant = 'default',
  size = 'sm',
  removable = false,
  onRemove,
  title,
  className,
}: TagChipProps) {
  const sizeCls =
    size === 'sm' ? 'text-xs px-1.5 py-0.5 gap-1' : 'text-sm px-2 py-1 gap-1.5';

  // Variants têm precedência sobre `color` quando explícitas (has/missing).
  let style: React.CSSProperties | undefined;
  let variantCls = '';

  if (variant === 'has') {
    variantCls = 'bg-green-100 text-green-800 border border-green-200';
  } else if (variant === 'missing') {
    variantCls = 'bg-red-100 text-red-800 border border-red-200';
  } else if (color && parseHex(color)) {
    // Usa cor da tag como background, escolhendo texto pelo contraste.
    const dark = isDarkBg(color);
    style = {
      backgroundColor: color,
      color: dark ? '#fff' : '#1f2937', // gray-800
      borderColor: color,
    };
    variantCls = 'border';
  } else {
    variantCls = 'bg-gray-100 text-gray-700 border border-gray-200';
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium select-none',
        sizeCls,
        variantCls,
        className,
      )}
      style={style}
      title={title}
    >
      <span className="truncate max-w-[14rem]">{name}</span>
      {removable && (
        <button
          type="button"
          aria-label={`Remover tag ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
          className="ml-0.5 inline-flex items-center justify-center rounded-full hover:bg-black/10 focus:outline-none focus:ring-1 focus:ring-current"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
