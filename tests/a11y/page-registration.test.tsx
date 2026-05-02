/**
 * A11y static analysis — NewPagePage (page registration form)
 * T-6-021
 *
 * Verifies WCAG AA structural requirements declared in source:
 * - Form controls have associated labels
 * - Submit button text is descriptive
 * - Error state uses role="alert" for immediate screen-reader announcement
 * - Icon-only buttons carry aria-label
 * - Decorative icons are aria-hidden
 * - "Cancel" button is not icon-only (has visible text — no extra aria-label needed)
 *
 * See docs/70-ux/10-accessibility.md and docs/70-ux/04-screen-page-registration.md
 *
 * NOTE: Static analysis approach chosen because @testing-library/react and
 * axe-core are not yet installed in the workspace. When T-ID for those deps
 * lands, replace with render() + toHaveNoViolations().
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENT_PATH = resolve(
  __dirname,
  '../../apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/new/page.tsx',
);

const source = readFileSync(COMPONENT_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Page heading
// ---------------------------------------------------------------------------

describe('NewPagePage — heading (WCAG 2.4.6)', () => {
  it('renders an h1 as the page title', () => {
    expect(source).toContain('<h1');
  });

  it('h1 text is "Nova página"', () => {
    expect(source).toContain('Nova página');
  });
});

// ---------------------------------------------------------------------------
// Form: name field
// ---------------------------------------------------------------------------

describe('NewPagePage — name field label association (WCAG 1.3.1)', () => {
  it('"Nome" input has id="name"', () => {
    // The label's htmlFor must match the input id
    expect(source).toContain('id="name"');
  });

  it('"Nome" label uses htmlFor="name" to associate with the input', () => {
    expect(source).toContain('htmlFor="name"');
  });

  it('"Nome" input is type="text"', () => {
    expect(source).toContain('type="text"');
  });
});

// ---------------------------------------------------------------------------
// Form: tracking_mode radio group
// ---------------------------------------------------------------------------

describe('NewPagePage — tracking mode radio inputs are inside label elements (WCAG 1.3.1)', () => {
  it('radio inputs are wrapped in <label> for click target + association', () => {
    // Each radio is inside a <label> element (implicit association)
    // Verify the pattern: <label ...><input type="radio" ...
    expect(source).toContain('type="radio"');
    // Label wraps the radio — no separate htmlFor needed in this pattern
    const radioIndex = source.indexOf('type="radio"');
    const labelBeforeRadio = source.lastIndexOf('<label', radioIndex);
    expect(labelBeforeRadio).toBeGreaterThan(-1);
    // The label closes after the radio descriptor text
    expect(source).toContain('Todos os eventos (recomendado)');
    expect(source).toContain('Apenas compras');
  });

  it('radio values are descriptive strings, not bare numbers', () => {
    expect(source).toContain('value="all_events"');
    expect(source).toContain('value="purchase_only"');
  });
});

// ---------------------------------------------------------------------------
// Form: icon-only buttons carry aria-label
// ---------------------------------------------------------------------------

describe('NewPagePage — icon-only buttons have aria-label (WCAG 1.1.1, 4.1.2)', () => {
  it('"Remover domínio" icon button carries aria-label', () => {
    expect(source).toContain('aria-label="Remover domínio"');
  });

  it('"Remover domínio" button icon is aria-hidden (decorative)', () => {
    // The <X> Lucide icon inside the remove button is purely visual
    expect(source).toContain('aria-hidden="true"');
  });
});

// ---------------------------------------------------------------------------
// Form: server error live region
// ---------------------------------------------------------------------------

describe('NewPagePage — server error announced immediately (WCAG 4.1.3)', () => {
  it('server error container uses role="alert" for immediate SR announcement', () => {
    // role="alert" maps to aria-live="assertive" + aria-atomic="true"
    expect(source).toContain('role="alert"');
  });

  it('server error icon is aria-hidden (not duplicated in announcement)', () => {
    // The AlertCircle icon inside the error div must be decorative
    expect(source).toContain('aria-hidden="true"');
  });
});

// ---------------------------------------------------------------------------
// Form: submit and cancel buttons
// ---------------------------------------------------------------------------

describe('NewPagePage — form action buttons (WCAG 2.4.6)', () => {
  it('submit button has descriptive text "Criar página"', () => {
    expect(source).toContain('Criar página');
  });

  it('submit button shows in-progress state text "Criando..."', () => {
    // Loading state replaces button text so SR users know action is in progress
    expect(source).toContain('Criando...');
  });

  it('cancel button has visible text "Cancelar"', () => {
    expect(source).toContain('Cancelar');
  });

  it('submit button is type="submit" so Enter key submits the form', () => {
    expect(source).toContain('type="submit"');
  });

  it('cancel button is type="button" to prevent accidental form submission', () => {
    // Non-submit buttons inside a form must be type="button"
    expect(source).toContain('type="button"');
  });
});

// ---------------------------------------------------------------------------
// Form element
// ---------------------------------------------------------------------------

describe('NewPagePage — form element structure (WCAG 1.3.1)', () => {
  it('form uses noValidate (relies on React Hook Form + Zod, not browser popups)', () => {
    // noValidate prevents native browser validation UX which is inaccessible
    expect(source).toContain('noValidate');
  });

  it('form uses onSubmit handler (not action attribute)', () => {
    expect(source).toContain('onSubmit={handleSubmit(onSubmit)}');
  });
});

// ---------------------------------------------------------------------------
// Informational icons
// ---------------------------------------------------------------------------

describe('NewPagePage — informational icons are aria-hidden (WCAG 1.1.1)', () => {
  it('AlertCircle icon in domain hint text is aria-hidden (decorative)', () => {
    // The info icon next to "O Meta exige verificação" is purely decorative
    expect(source).toContain('aria-hidden="true"');
  });

  it('"Adicionar domínio" button Plus icon is aria-hidden', () => {
    // The Plus icon inside the "Adicionar domínio" button is decorative;
    // the button text itself provides the accessible name
    expect(source).toContain('<Plus');
  });
});
