import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

// Workerd (Hyperdrive local dev) returns unencoded slashes in the password
// portion of the connection string, which breaks URL parsing in postgres.js.
// Re-encode slashes between the first colon (after user) and the @ sign.
function sanitizeConnStr(raw: string): string {
  return raw.replace(
    /^(postgres(?:ql)?:\/\/[^:]+:)([^@]*)(@)/,
    (_, prefix, password, at) => prefix + password.replace(/\//g, '%2F') + at,
  );
}

export function createDb(connectionString: string) {
  const client = postgres(sanitizeConnStr(connectionString), { prepare: false });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export * from './schema/index.js';
