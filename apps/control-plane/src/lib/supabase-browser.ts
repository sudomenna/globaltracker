import { createBrowserClient } from '@supabase/ssr';

export function createSupabaseBrowser() {
  // biome-ignore lint/style/noNonNullAssertion: env vars are required at runtime; validated via .env.local
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // biome-ignore lint/style/noNonNullAssertion: env vars are required at runtime; validated via .env.local
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createBrowserClient(url, anonKey);
}
