import { type CookieOptions, createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // biome-ignore lint/style/noNonNullAssertion: env vars required at runtime; validated via .env.local
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // biome-ignore lint/style/noNonNullAssertion: env vars required at runtime; validated via .env.local
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options: CookieOptions;
        }[],
      ) {
        // biome-ignore lint/complexity/noForEach: required by @supabase/ssr cookie API
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        // biome-ignore lint/complexity/noForEach: required by @supabase/ssr cookie API
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // Refresh the session — required per @supabase/ssr docs
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Redirecionar para login se não autenticado (exceto na rota de login)
  if (!user && !request.nextUrl.pathname.startsWith('/login')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
