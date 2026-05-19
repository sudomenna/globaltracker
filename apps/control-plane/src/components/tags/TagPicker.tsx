'use client';

import { cn } from '@/lib/utils';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { TagChip } from './TagChip';

export interface TagOption {
  id: string;
  name: string;
  color?: string | null;
}

export interface TagPickerProps {
  availableTags: TagOption[];
  selectedNames: string[];
  onChange: (names: string[]) => void;
  /** Mostra "+ Criar 'xxx'" quando o texto digitado não casa nenhum item. Default true. */
  allowCreate?: boolean;
  placeholder?: string;
  /** Default true. Se false, fecha após selecionar (single-select). */
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
}

export function TagPicker({
  availableTags,
  selectedNames,
  onChange,
  allowCreate = true,
  placeholder = 'Buscar ou criar tag...',
  multiple = true,
  disabled = false,
  className,
}: TagPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const selectedSet = useMemo(
    () => new Set(selectedNames.map((n) => n.toLowerCase())),
    [selectedNames],
  );

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return availableTags;
    return availableTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [availableTags, q]);

  // "Criar" só aparece se: query não vazia, allowCreate, não existe match
  // exato (case-insensitive) entre disponíveis nem entre selecionadas.
  const exactInAvailable = availableTags.some(
    (t) => t.name.toLowerCase() === q,
  );
  const exactInSelected = selectedSet.has(q);
  const showCreate = allowCreate && q.length > 0 && !exactInAvailable && !exactInSelected;

  type ListItem =
    | { kind: 'tag'; tag: TagOption }
    | { kind: 'create'; name: string };

  const items: ListItem[] = useMemo(() => {
    const arr: ListItem[] = matches.map((tag) => ({ kind: 'tag', tag }));
    if (showCreate) arr.push({ kind: 'create', name: query.trim() });
    return arr;
  }, [matches, showCreate, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, []);

  // Click outside
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const select = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const lower = trimmed.toLowerCase();
      if (selectedSet.has(lower)) {
        // Já está; em multi, remover; em single, manter e fechar.
        if (multiple) {
          onChange(selectedNames.filter((n) => n.toLowerCase() !== lower));
        }
      } else {
        const next = multiple ? [...selectedNames, trimmed] : [trimmed];
        onChange(next);
      }
      setQuery('');
      setActiveIdx(0);
      if (!multiple) {
        setOpen(false);
        inputRef.current?.blur();
      } else {
        inputRef.current?.focus();
      }
    },
    [selectedNames, selectedSet, multiple, onChange],
  );

  const remove = useCallback(
    (name: string) => {
      onChange(selectedNames.filter((n) => n.toLowerCase() !== name.toLowerCase()));
    },
    [selectedNames, onChange],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIdx((i) => (items.length === 0 ? 0 : Math.min(i + 1, items.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const it = items[activeIdx];
      if (!it) return;
      if (it.kind === 'tag') select(it.tag.name);
      else select(it.name);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Backspace' && query.length === 0 && selectedNames.length > 0) {
      // Apaga a última chip ao dar backspace no input vazio
      remove(selectedNames[selectedNames.length - 1] as string);
    }
  }

  // Resolve color de chip selecionado a partir do catálogo (se existir).
  const resolveColor = useCallback(
    (name: string): string | null => {
      const t = availableTags.find(
        (x) => x.name.toLowerCase() === name.toLowerCase(),
      );
      return t?.color ?? null;
    },
    [availableTags],
  );

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative w-full',
        disabled && 'opacity-60 pointer-events-none',
        className,
      )}
    >
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring"
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        {selectedNames.map((name) => (
          <TagChip
            key={name}
            name={name}
            color={resolveColor(name)}
            removable
            onRemove={() => remove(name)}
          />
        ))}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={selectedNames.length === 0 ? placeholder : ''}
          disabled={disabled}
          className="flex-1 min-w-[8rem] bg-transparent outline-none placeholder:text-muted-foreground text-sm"
        />
      </div>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-md border border-input bg-popover text-popover-foreground shadow-md"
        >
          {items.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              Nenhuma tag encontrada
            </li>
          )}
          {items.map((it, idx) => {
            const active = idx === activeIdx;
            const isSelected =
              it.kind === 'tag' && selectedSet.has(it.tag.name.toLowerCase());
            return (
              <li
                key={it.kind === 'tag' ? `t-${it.tag.id}` : `c-${it.name}`}
                role="option"
                aria-selected={isSelected}
                className={cn(
                  'flex items-center justify-between gap-2 px-3 py-1.5 cursor-pointer text-sm',
                  active && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => setActiveIdx(idx)}
                onMouseDown={(e) => {
                  // Previne blur do input antes do click
                  e.preventDefault();
                }}
                onClick={() => {
                  if (it.kind === 'tag') select(it.tag.name);
                  else select(it.name);
                }}
              >
                {it.kind === 'tag' ? (
                  <>
                    <TagChip name={it.tag.name} color={it.tag.color} />
                    {isSelected && (
                      <span className="text-xs text-muted-foreground">
                        selecionada
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-sm">
                    + Criar tag <strong>&ldquo;{it.name}&rdquo;</strong>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
