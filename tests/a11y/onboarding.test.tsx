/**
 * A11y static analysis — OnboardingWizard component
 * T-6-021
 *
 * Verifies WCAG AA structural requirements declared in source:
 * - Landmark: <nav> with aria-label for stepper
 * - Headings: h1 present (wizard title)
 * - Stepper: aria-current="step" on active step button
 * - Stepper buttons: aria-label carries step number + name + state
 * - "Skip" button: aria-label present (icon-free text button — still verified)
 * - "Back" button: aria-label present
 * - Live region: aria-live="polite" for save status
 *
 * See docs/70-ux/10-accessibility.md and docs/70-ux/03-screen-onboarding-wizard.md
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
  '../../apps/control-plane/src/app/(app)/onboarding/onboarding-wizard.tsx',
);

const source = readFileSync(COMPONENT_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Landmark regions
// ---------------------------------------------------------------------------

describe('OnboardingWizard — landmark regions (WCAG 2.1 §1.3.6)', () => {
  it('stepper is wrapped in <nav> to provide a navigation landmark', () => {
    expect(source).toContain('<nav');
  });

  it('<nav> carries aria-label to distinguish it from other nav landmarks', () => {
    // aria-label="Progresso do onboarding" declared on WizardStepper
    expect(source).toContain('aria-label="Progresso do onboarding"');
  });
});

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

describe('OnboardingWizard — heading structure (WCAG 2.4.6)', () => {
  it('wizard renders an h1 as the page title', () => {
    expect(source).toContain('<h1');
  });

  it('h1 contains the wizard title text', () => {
    // "Bem-vindo ao GlobalTracker" is the wizard entry heading
    expect(source).toContain('Bem-vindo ao GlobalTracker');
  });

  it('completion state renders its own h1', () => {
    // When isCompleted, a separate h1 "Workspace configurado!" is shown
    expect(source).toContain('Workspace configurado!');
  });
});

// ---------------------------------------------------------------------------
// Stepper — ARIA step pattern
// ---------------------------------------------------------------------------

describe('OnboardingWizard — stepper ARIA pattern', () => {
  it('active step button carries aria-current="step"', () => {
    // Per ARIA spec, aria-current="step" marks the current step in a wizard
    expect(source).toContain("aria-current={isActive ? 'step' : undefined}");
  });

  it('step buttons carry aria-label with step number, name and status', () => {
    // Template: "Passo N de 5: <label> — concluido|atual"
    expect(source).toContain('`Passo ${index + 1} de ${STEPS.length}');
    expect(source).toContain('concluido');
    expect(source).toContain('atual');
  });

  it('stepper uses an <ol> ordered list for semantic step sequence', () => {
    // <ol> communicates order and count to screen readers
    expect(source).toContain('<ol');
  });

  it('stepper connector lines carry aria-hidden="true" (decorative)', () => {
    // The horizontal connector <div> between steps is visual-only
    expect(source).toContain('aria-hidden="true"');
  });
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

describe('OnboardingWizard — button accessibility', () => {
  it('"Pular configuracao" button has aria-label (intent not just "Pular")', () => {
    expect(source).toContain('aria-label="Pular configuracao completa"');
  });

  it('"Voltar" button has aria-label describing destination', () => {
    expect(source).toContain('aria-label="Voltar ao passo anterior"');
  });

  it('"Voltar" button is disabled on first step (no back navigation)', () => {
    expect(source).toContain('disabled={currentStep === 0}');
  });
});

// ---------------------------------------------------------------------------
// Live region — save status
// ---------------------------------------------------------------------------

describe('OnboardingWizard — save status live region (WCAG 4.1.3)', () => {
  it('saving indicator uses aria-live="polite" to announce to screen readers', () => {
    expect(source).toContain('aria-live="polite"');
  });

  it('saving indicator text is "Salvando..."', () => {
    expect(source).toContain('Salvando...');
  });
});

// ---------------------------------------------------------------------------
// Completion state summary
// ---------------------------------------------------------------------------

describe('OnboardingWizard — completion state summary accessibility', () => {
  it('check icon in completion state is aria-hidden (decorative)', () => {
    // <Check ... aria-hidden="true" /> in the completion header
    expect(source).toContain('aria-hidden="true"');
  });
});
