/**
 * Sanitização de payloads para dispatch_attempts.
 *
 * Os campos `request_payload_sanitized` e `response_payload_sanitized`
 * são storage de auditoria para entender o que efetivamente saiu para
 * Meta/Google/GA4. PII em claro NUNCA deve aparecer:
 *
 *   - Email/phone: já são SHA-256 em todos payloads de CAPI/Conversions
 *     APIs por design das APIs externas.
 *   - IP: enviado em claro para Meta CAPI (necessário para match), mas
 *     sob LGPD é PII pseudonimizada — duplicar em outra coluna é mais
 *     superfície de exposição. **REDACTED** aqui.
 *   - User-Agent: envia em claro mas não identifica unicamente; mantemos
 *     para auditoria de match quality (Meta usa pra device match).
 *
 * Helper é defensivo: se o dispatcher esquecer de chamar, IPs em claro
 * vazariam. Por isso `processDispatchJob` aplica este helper como última
 * camada antes do INSERT, idempotente.
 *
 * BR-PRIVACY-001: nenhum log/jsonb pode conter PII em claro.
 */

const IP_REDACTED = '[REDACTED]';

/**
 * Recursivamente percorre o valor e redacta IPs em claro nas chaves
 * conhecidas. Mutates a copy — não modifica o input original.
 *
 * Chaves redacted: `client_ip_address`, `ip` (Meta CAPI usa
 * `client_ip_address`; alguns providers usam só `ip`).
 *
 * Comportamento:
 *   - Objects: deep clone substituindo chaves IP por '[REDACTED]'.
 *   - Arrays: percorre cada elemento.
 *   - Primitivos: retorna como está.
 *   - null/undefined: retorna como está.
 *
 * Performance: payloads de dispatch são pequenos (KB), JSON-stringify
 * + parse seria mais simples mas perde tipos. Recursão direta é OK.
 */
export function sanitizeDispatchPayload(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    return input.map(sanitizeDispatchPayload);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === 'client_ip_address' || key === 'ip') {
      // Sinaliza presença ('non-empty string' OU `null`) sem expor o valor real.
      out[key] =
        typeof value === 'string' && value.length > 0 ? IP_REDACTED : value;
    } else {
      out[key] = sanitizeDispatchPayload(value);
    }
  }
  return out;
}
