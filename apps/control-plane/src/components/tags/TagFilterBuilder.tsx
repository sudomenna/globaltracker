'use client';

import { cn } from '@/lib/utils';
import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

export interface TagFilterClause {
  has: boolean;
  tag: string;
}

export interface TagFilterValue {
  op: 'and' | 'or';
  clauses: TagFilterClause[];
}

export interface TagFilterBuilderProps {
  value: TagFilterValue;
  onChange: (next: TagFilterValue) => void;
  availableTags: Array<{ id: string; name: string }>;
  className?: string;
}

const MAX_CLAUSES = 20;

// ---------------------------------------------------------------------------
// SingleTagCombobox — autocomplete single-select interno
// ---------------------------------------------------------------------------

interface SingleTagComboboxProps {
  value: string;
  onChange: (next: string) => void;
  availableTags: Array<{ id: string; name: string }>;
  placeholder?: string;
}

function SingleTagCombobox({
  value,
  onChange,
  availableTags,
  placeholder = 'Selecione uma tag',
}: SingleTagComboboxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return availableTags;
    return availableTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [availableTags, q]);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  function pick(name: string) {
    onChange(name);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = matches[activeIdx];
      if (item) pick(item.name);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div ref={rootRef} className="relative flex-1 min-w-[10rem]">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        value={open ? query : value}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-56 overflow-auto rounded-md border border-input bg-popover text-popover-foreground shadow-md"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              Nenhuma tag
            </li>
          ) : (
            matches.map((t, idx) => {
              const active = idx === activeIdx;
              const selected = t.name === value;
              return (
                <li
                  key={t.id}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    'px-3 py-1.5 cursor-pointer text-sm flex items-center justify-between',
                    active && 'bg-accent text-accent-foreground',
                  )}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(t.name)}
                >
                  <span>{t.name}</span>
                  {selected && (
                    <span className="text-xs text-muted-foreground">atual</span>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TagFilterBuilder
// ---------------------------------------------------------------------------

export function TagFilterBuilder({
  value,
  onChange,
  availableTags,
  className,
}: TagFilterBuilderProps) {
  const setOp = useCallback(
    (op: 'and' | 'or') => onChange({ ...value, op }),
    [value, onChange],
  );

  const updateClause = useCallback(
    (idx: number, patch: Partial<TagFilterClause>) => {
      const next = value.clauses.slice();
      const current = next[idx];
      if (!current) return;
      next[idx] = { ...current, ...patch };
      onChange({ ...value, clauses: next });
    },
    [value, onChange],
  );

  const removeClause = useCallback(
    (idx: number) => {
      onChange({
        ...value,
        clauses: value.clauses.filter((_, i) => i !== idx),
      });
    },
    [value, onChange],
  );

  const addClause = useCallback(() => {
    if (value.clauses.length >= MAX_CLAUSES) return;
    onChange({
      ...value,
      clauses: [...value.clauses, { has: true, tag: '' }],
    });
  }, [value, onChange]);

  const atMax = value.clauses.length >= MAX_CLAUSES;

  return (
    <div
      className={cn(
        'rounded-md border border-input bg-background p-3 space-y-3',
        className,
      )}
      aria-label="Filtros de tag"
    >
      <header className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Filtros de tag
        </span>
        <div
          role="radiogroup"
          aria-label="Combinador de cláusulas"
          className="inline-flex rounded-md border border-input overflow-hidden"
        >
          <button
            type="button"
            role="radio"
            aria-checked={value.op === 'and'}
            onClick={() => setOp('and')}
            className={cn(
              'px-2 py-1 text-xs font-medium',
              value.op === 'and'
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-accent',
            )}
          >
            AND
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={value.op === 'or'}
            onClick={() => setOp('or')}
            className={cn(
              'px-2 py-1 text-xs font-medium border-l border-input',
              value.op === 'or'
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-accent',
            )}
          >
            OR
          </button>
        </div>
      </header>

      {value.clauses.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nenhuma regra. Adicione abaixo para filtrar por tag.
        </p>
      ) : (
        <ul className="space-y-2">
          {value.clauses.map((clause, idx) => (
            <li
              key={idx}
              className="flex items-center gap-2"
            >
              <select
                aria-label="Operador da cláusula"
                value={clause.has ? 'has' : 'missing'}
                onChange={(e) =>
                  updateClause(idx, { has: e.target.value === 'has' })
                }
                className="rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="has">Possui</option>
                <option value="missing">Não tem</option>
              </select>
              <SingleTagCombobox
                value={clause.tag}
                onChange={(name) => updateClause(idx, { tag: name })}
                availableTags={availableTags}
                placeholder="Escolha a tag"
              />
              <button
                type="button"
                aria-label="Remover cláusula"
                onClick={() => removeClause(idx)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={addClause}
        disabled={atMax}
        aria-label="Adicionar regra"
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md',
          atMax
            ? 'text-muted-foreground cursor-not-allowed'
            : 'text-primary hover:bg-accent',
        )}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        adicionar regra
        {atMax && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            (máx {MAX_CLAUSES})
          </span>
        )}
      </button>
    </div>
  );
}
