/**
 * Unit tests — sanitizeDispatchPayload
 *
 * Garante que IPs em claro são redacted antes de gravar em
 * dispatch_attempts.{request,response}_payload_sanitized.
 *
 * BR-PRIVACY-001: nenhum log/jsonb pode conter PII em claro.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeDispatchPayload } from '../../../apps/edge/src/lib/dispatch-payload-sanitize';

describe('sanitizeDispatchPayload', () => {
  it('redacta client_ip_address em objeto raso', () => {
    const out = sanitizeDispatchPayload({
      em: 'hash-do-email',
      client_ip_address: '2804:14d:baa4:4641::1',
    });
    expect(out).toEqual({
      em: 'hash-do-email',
      client_ip_address: '[REDACTED]',
    });
  });

  it('redacta client_ip_address aninhado em data[].user_data (Meta CAPI)', () => {
    const metaPayload = {
      data: [
        {
          event_name: 'Lead',
          user_data: {
            em: 'sha256-email',
            ph: 'sha256-phone',
            client_ip_address: '189.5.10.20',
            client_user_agent: 'Mozilla/5.0',
          },
        },
      ],
    };
    const out = sanitizeDispatchPayload(metaPayload) as typeof metaPayload;
    expect(out.data[0]?.user_data.client_ip_address).toBe('[REDACTED]');
    // user_agent NÃO é PII per se — preservar pra auditoria de match quality
    expect(out.data[0]?.user_data.client_user_agent).toBe('Mozilla/5.0');
    // Hashes preservados
    expect(out.data[0]?.user_data.em).toBe('sha256-email');
    expect(out.data[0]?.user_data.ph).toBe('sha256-phone');
  });

  it('redacta também a chave alternativa `ip` (alguns providers)', () => {
    const out = sanitizeDispatchPayload({
      ip: '10.0.0.1',
      other: 'keep',
    });
    expect(out).toEqual({ ip: '[REDACTED]', other: 'keep' });
  });

  it('preserva null/undefined em chaves de IP (não inventa REDACTED)', () => {
    const out = sanitizeDispatchPayload({
      client_ip_address: null,
      ip: undefined,
    });
    expect(out).toEqual({ client_ip_address: null, ip: undefined });
  });

  it('preserva string vazia (não considera PII)', () => {
    const out = sanitizeDispatchPayload({ client_ip_address: '' });
    expect(out).toEqual({ client_ip_address: '' });
  });

  it('é idempotente — segundo passe não muda nada', () => {
    const once = sanitizeDispatchPayload({
      user_data: { client_ip_address: '1.2.3.4' },
    });
    const twice = sanitizeDispatchPayload(once);
    expect(twice).toEqual(once);
  });

  it('aceita primitivos sem quebrar', () => {
    expect(sanitizeDispatchPayload(42)).toBe(42);
    expect(sanitizeDispatchPayload('string')).toBe('string');
    expect(sanitizeDispatchPayload(null)).toBe(null);
    expect(sanitizeDispatchPayload(undefined)).toBe(undefined);
  });

  it('não muta o input original (deep clone defensivo)', () => {
    const input = {
      data: [{ user_data: { client_ip_address: '1.2.3.4' } }],
    };
    const original = JSON.parse(JSON.stringify(input));
    sanitizeDispatchPayload(input);
    expect(input).toEqual(original);
  });

  it('redacta em arrays no nível raiz', () => {
    const out = sanitizeDispatchPayload([
      { client_ip_address: '1.1.1.1' },
      { client_ip_address: '2.2.2.2' },
    ]);
    expect(out).toEqual([
      { client_ip_address: '[REDACTED]' },
      { client_ip_address: '[REDACTED]' },
    ]);
  });
});
