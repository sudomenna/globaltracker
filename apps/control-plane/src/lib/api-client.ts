// Cliente para chamadas ao Edge Worker
// Autenticação: Bearer token do Supabase session

export async function edgeFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<Response> {
  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ??
    process.env.EDGE_WORKER_URL ??
    'http://localhost:8787';
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...init?.headers,
    },
  });
}
