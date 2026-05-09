/**
 * TabsWithUrlSync — client wrapper around Radix Tabs (T-17-011).
 *
 * Sincroniza a aba ativa com a query string (?tab=...). O <Tabs.Root> precisa
 * ser client component porque é controlled e reage a interação; mas o conteúdo
 * pode continuar sendo server components passados como children.
 *
 * Mantém compatibilidade com outros params (?types, ?status, ?period) — apenas
 * substitui/adiciona o param `tab`, sem tocar nos demais.
 */

'use client';

import { Tabs } from '@/components/ui/tabs';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

interface TabsWithUrlSyncProps {
  defaultValue: string;
  validValues: readonly string[];
  children: React.ReactNode;
  className?: string;
}

export function TabsWithUrlSync({
  defaultValue,
  validValues,
  children,
  className,
}: TabsWithUrlSyncProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initial = (() => {
    const fromUrl = searchParams.get('tab');
    if (fromUrl && validValues.includes(fromUrl)) return fromUrl;
    return defaultValue;
  })();

  const [value, setValue] = useState<string>(initial);

  // Mantém estado em sync caso a URL seja alterada externamente (back/forward).
  useEffect(() => {
    const fromUrl = searchParams.get('tab');
    const next = fromUrl && validValues.includes(fromUrl) ? fromUrl : defaultValue;
    setValue((prev) => (prev === next ? prev : next));
  }, [searchParams, validValues, defaultValue]);

  const onValueChange = useCallback(
    (next: string) => {
      setValue(next);
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      defaultValue={defaultValue}
      className={className}
    >
      {children}
    </Tabs>
  );
}
