/**
 * pii-mask.ts — Mask helpers for displaying PII partially.
 *
 * ADR-034 / BR-IDENTITY-006: roles operator/viewer recebem PII mascarado
 * na lista; reveal-on-demand entrega o valor em claro.
 */

/**
 * Mask email: 1ª letra + `***@<domínio>`.
 *
 * Examples:
 *   tiagomenna@gmail.com → t***@gmail.com
 *   ab@x.com             → a***@x.com
 *   no-at-symbol         → ***
 */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const first = email.charAt(0);
  const domain = email.slice(at + 1);
  return `${first}***@${domain}`;
}

/**
 * Mask phone: keeps DDI + DDD + 1º dígito + `****` + últimos 4.
 *
 * Examples:
 *   +5511987654321 → +55 11 9****-4321
 *   +551141234567  → +55 11 4****-4567 (landline-ish)
 *   short           → ****
 */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return '****';

  if (digits.length === 13 && digits.startsWith('55')) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits[4]}****-${digits.slice(9)}`;
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits[4]}****-${digits.slice(8)}`;
  }
  // Generic fallback: last 4 visible.
  return `****${digits.slice(-4)}`;
}
