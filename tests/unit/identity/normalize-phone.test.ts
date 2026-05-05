/**
 * Unit tests — normalizePhone (BR-aware 9-prefix reconciliation).
 *
 * T-13-014.
 * BR-IDENTITY-002: normalize before hash.
 * INV-IDENTITY-007: phone → E.164.
 * INV-IDENTITY-008: BR mobile canônico = 13 dígitos `+55DD9XXXXXXXX`;
 *                   BR landline canônico = 12 dígitos `+55DDXXXXXXXX`.
 *
 * Heurística: landline brasileiro NUNCA começa com 6/7/8/9. Logo, formato
 * 8-dígitos local-part começando com [6-9] é sempre mobile-sem-9 → reconstrói.
 */

import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../../apps/edge/src/lib/lead-resolver';

const BR_MOBILE_CANONICAL = '+5551995849212';
const BR_LANDLINE_CANONICAL = '+555132345678';

describe('normalizePhone — BR mobile (with or without legacy 9)', () => {
  const mobileVariants: Array<[string, string]> = [
    ['+5551995849212', 'E.164 canônico'],
    ['5551995849212', 'digits only, country code, with 9'],
    ['51995849212', 'digits only, no country, with 9 (11 digits)'],
    ['5195849212', 'digits only, no country, NO 9 (10 digits) — insere'],
    ['555195849212', 'digits only, country code, NO 9 (12 digits) — insere'],
    ['+555195849212', 'with +, country, NO 9 — insere'],
    ['(51) 99584-9212', 'human format with 9'],
    ['(51) 9584-9212', 'human format without 9 — insere'],
    ['+55 (51) 9 9584-9212', '+55 with separated 9'],
    ['+55 51 9584 9212', '+55 with spaces, sem 9 — insere'],
    ['  5195849212  ', 'whitespace + sem 9 — insere'],
  ];

  for (const [input, label] of mobileVariants) {
    it(`mobile → canonical (${label}): ${JSON.stringify(input)}`, () => {
      expect(normalizePhone(input)).toBe(BR_MOBILE_CANONICAL);
    });
  }
});

describe('normalizePhone — BR landline (sem inserção de 9)', () => {
  const landlineVariants: Array<[string, string]> = [
    ['5132345678', 'digits only, no country'],
    ['+555132345678', 'E.164'],
    ['555132345678', 'digits only, country code'],
    ['(51) 3234-5678', 'human format'],
    ['+55 51 3234-5678', '+55 with spaces'],
  ];

  for (const [input, label] of landlineVariants) {
    it(`landline mantém 12-dígitos (${label}): ${JSON.stringify(input)}`, () => {
      expect(normalizePhone(input)).toBe(BR_LANDLINE_CANONICAL);
    });
  }

  it('landline com primeiro dígito 2/3/4/5 não recebe 9 inserido', () => {
    // DDD 11, landline starting with 2 → `+551123456789` is 12 chars (correct landline)
    expect(normalizePhone('1123456789')).toBe('+551123456789');
    // DDD 11, landline starting with 4
    expect(normalizePhone('1145678901')).toBe('+551145678901');
  });
});

describe('normalizePhone — internacional preservado (não-BR)', () => {
  it('US E.164 não muda (no 9-prefix logic)', () => {
    expect(normalizePhone('+14155552671')).toBe('+14155552671');
  });

  it('UK E.164 não muda', () => {
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
  });

  it('PT E.164 não muda', () => {
    expect(normalizePhone('+351211234567')).toBe('+351211234567');
  });
});

describe('normalizePhone — inputs inválidos retornam null', () => {
  const nullCases: Array<[string, string]> = [
    ['', 'string vazia'],
    ['   ', 'só espaços'],
    ['abc', 'só letras'],
    ['9999', 'curto demais (4 dígitos)'],
    ['12345', '5 dígitos'],
    ['123456789', '9 dígitos sem +'],
  ];

  for (const [input, label] of nullCases) {
    it(`null para input inválido (${label}): ${JSON.stringify(input)}`, () => {
      expect(normalizePhone(input)).toBeNull();
    });
  }
});

describe('normalizePhone — idempotência', () => {
  const idempotentInputs = [
    '+5551995849212',
    '5195849212',
    '+555195849212',
    '(51) 99584-9212',
    '+555132345678',
    '+14155552671',
  ];

  for (const input of idempotentInputs) {
    it(`idempotente: ${JSON.stringify(input)}`, () => {
      const once = normalizePhone(input);
      expect(once).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      const twice = normalizePhone(once!);
      expect(twice).toBe(once);
    });
  }
});

describe('normalizePhone — regressão (casos do test legacy)', () => {
  // Casos que já estão em lead-resolver-no-match.test.ts — replicados aqui pra
  // garantir que o algoritmo novo não quebra os antigos.
  it('+5511999990000 (canônico São Paulo)', () => {
    expect(normalizePhone('+5511999990000')).toBe('+5511999990000');
  });

  it('11999990000 (sem country, com 9)', () => {
    expect(normalizePhone('11999990000')).toBe('+5511999990000');
  });

  it('(11) 99999-0000', () => {
    expect(normalizePhone('(11) 99999-0000')).toBe('+5511999990000');
  });
});
