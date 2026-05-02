'use client';

import { Toaster } from 'sonner';
import { SWRConfig } from 'swr';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ revalidateOnFocus: false }}>
      {children}
      <Toaster position="top-right" />
    </SWRConfig>
  );
}
