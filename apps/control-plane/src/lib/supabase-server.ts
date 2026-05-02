import { type CookieOptions, createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createSupabaseServer() {
  const cookieStore = await cookies();
  // biome-ignore lint/style/noNonNullAssertion: env vars required at runtime; validated via .env.local
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // biome-ignore lint/style/noNonNullAssertion: env vars required at runtime; validated via .env.local
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options: CookieOptions;
        }[],
      ) {
        try {
          // biome-ignore lint/complexity/noForEach: required by @supabase/ssr cookie API
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // setAll called from Server Component — ignore cookie mutation errors
        }
      },
    },
  });
}
