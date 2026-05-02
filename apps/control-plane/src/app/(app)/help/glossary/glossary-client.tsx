'use client';

import { cn } from '@/lib/utils';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export interface GlossaryTerm {
  term: string;
  definition: string;
  notConfuse?: string;
}

interface GlossaryClientProps {
  terms: GlossaryTerm[];
}

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function firstChar(term: string): string {
  return term.charAt(0).toUpperCase();
}

export function GlossaryClient({ terms }: GlossaryClientProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return terms;
    return terms.filter(
      (t) =>
        t.term.toLowerCase().includes(q) ||
        t.definition.toLowerCase().includes(q),
    );
  }, [terms, debouncedQuery]);

  const byLetter = useMemo(() => {
    const map = new Map<string, GlossaryTerm[]>();
    for (const t of filtered) {
      const letter = firstChar(t.term);
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)?.push(t);
    }
    return map;
  }, [filtered]);

  const activeLetters = useMemo(() => new Set(byLetter.keys()), [byLetter]);

  const termId = (term: string) =>
    term
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar termo ou definição…"
          aria-label="Buscar no glossário"
          className={cn(
            'w-full rounded-md border border-input bg-background pl-9 pr-4 py-2 text-sm',
            'placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          )}
        />
      </div>

      {/* Jump links A–Z */}
      <nav aria-label="Ir para letra" className="flex flex-wrap gap-1">
        {ALPHABET.map((letter) => {
          const active = activeLetters.has(letter);
          return (
            <a
              key={letter}
              href={active ? `#letra-${letter}` : undefined}
              aria-disabled={!active}
              tabIndex={active ? 0 : -1}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded text-xs font-medium',
                active
                  ? 'bg-accent text-accent-foreground hover:bg-accent/80'
                  : 'text-muted-foreground opacity-40 cursor-default',
              )}
            >
              {letter}
            </a>
          );
        })}
      </nav>

      {/* No results */}
      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nenhum termo encontrado para &ldquo;{debouncedQuery}&rdquo;.
        </p>
      )}

      {/* Term groups by letter */}
      {ALPHABET.filter((l) => byLetter.has(l)).map((letter) => {
        const group = byLetter.get(letter) ?? [];
        return (
          <section key={letter} id={`letra-${letter}`}>
            <h2 className="text-lg font-semibold mb-3 border-b pb-1">
              {letter}
            </h2>
            <dl className="space-y-4">
              {group.map((t) => (
                <div key={t.term} id={termId(t.term)} className="scroll-mt-4">
                  <dt className="font-semibold text-sm">
                    <a
                      href={`#${termId(t.term)}`}
                      className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    >
                      {t.term}
                    </a>
                  </dt>
                  <dd className="mt-1 text-sm text-muted-foreground">
                    {t.definition}
                    {t.notConfuse && (
                      <span className="mt-1 block text-xs italic">
                        Não confundir com: {t.notConfuse}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}
