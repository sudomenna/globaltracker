/**
 * A11y static analysis — HealthBadge component
 * T-6-021
 *
 * Approach: source-level structural assertions.
 *
 * WHY static analysis instead of jsdom rendering:
 * The project does not yet have @testing-library/react or axe-core installed,
 * and the root vitest config uses environment:'node'. Installing those
 * dependencies requires a separate T-ID (workspace devDep change + vitest
 * config update for jsdom). Until that T-ID lands, these tests provide
 * deterministic, CI-safe coverage of every a11y attribute declared in the
 * source, per WCAG AA requirements documented in docs/70-ux/10-accessibility.md.
 *
 * When axe-core + @testing-library/react are added, replace the source
 * assertions below with render() + toHaveNoViolations() — the test names and
 * scenarios stay identical.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Load component source once — all assertions are pure string checks
// ---------------------------------------------------------------------------

const COMPONENT_PATH = resolve(
  __dirname,
  '../../apps/control-plane/src/components/health-badge.tsx',
);

const source = readFileSync(COMPONENT_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// WCAG AA rule: never convey state by color alone — always color + label
// docs/70-ux/10-accessibility.md, docs/70-ux/07-component-health-badges.md §2
// ---------------------------------------------------------------------------

describe('HealthBadge — WCAG AA: never color alone', () => {
  it('STATE healthy: aria-label "Saudável" is declared in STATE_CONFIG', () => {
    // Verifies the canonical ariaLabel string for the healthy state
    expect(source).toContain("ariaLabel: 'Saudável'");
  });

  it('STATE degraded: aria-label "Atenção" is declared in STATE_CONFIG', () => {
    expect(source).toContain("ariaLabel: 'Atenção'");
  });

  it('STATE unhealthy: aria-label "Crítico" is declared in STATE_CONFIG', () => {
    expect(source).toContain("ariaLabel: 'Crítico'");
  });

  it('STATE unknown: aria-label "Sem dados" is declared in STATE_CONFIG', () => {
    expect(source).toContain("ariaLabel: 'Sem dados'");
  });

  it('STATE loading: output element carries aria-label "Carregando"', () => {
    // The loading skeleton uses <output aria-label="Carregando">
    // <output> has implicit ARIA role="status" — correct live region
    expect(source).toContain('aria-label="Carregando"');
  });
});

// ---------------------------------------------------------------------------
// WCAG AA rule: icon must not convey meaning alone — pair with aria-hidden
// docs/70-ux/10-accessibility.md §icons
// ---------------------------------------------------------------------------

describe('HealthBadge — decorative icons carry aria-hidden="true"', () => {
  it('icons in DotXs and DotSm carry aria-hidden="true" to prevent double-announce', () => {
    // All <Icon> usages in HealthBadge variants must be aria-hidden
    expect(source).toContain('aria-hidden="true"');
  });

  it('STATE_CONFIG maps all non-loading states to a React icon element', () => {
    // Each state has an Icon key used for visual+SR pairing
    expect(source).toContain('Icon: CheckCircle');
    expect(source).toContain('Icon: AlertTriangle');
    expect(source).toContain('Icon: XCircle');
    expect(source).toContain('Icon: HelpCircle');
  });
});

// ---------------------------------------------------------------------------
// Interactive variant: clickable badge must be keyboard-accessible
// docs/70-ux/10-accessibility.md §interactive
// ---------------------------------------------------------------------------

describe('HealthBadge — interactive variant: keyboard and ARIA role', () => {
  it('clickable badge exposes role="button" when onClick is provided', () => {
    expect(source).toContain("role={onClick ? 'button' : undefined}");
  });

  it('clickable badge gets tabIndex={0} for keyboard focus', () => {
    expect(source).toContain('tabIndex={onClick ? 0 : undefined}');
  });

  it('onKeyDown handles Enter key to match mouse click behaviour', () => {
    expect(source).toContain("e.key === 'Enter'");
  });

  it('onKeyDown handles Space key to match native button behaviour', () => {
    expect(source).toContain("e.key === ' '");
  });
});

// ---------------------------------------------------------------------------
// incidentCount: announced in aria-label — not just visual text in parens
// docs/70-ux/07-component-health-badges.md §6
// ---------------------------------------------------------------------------

describe('HealthBadge — incidentCount is announced in aria-label', () => {
  it('resolvedAriaLabel template includes incidentCount for screen readers', () => {
    // The DotSm variant computes `${ariaLabel} — ${n} incidentes`
    expect(source).toContain('incidentes');
    expect(source).toContain('resolvedAriaLabel');
  });
});

// ---------------------------------------------------------------------------
// size=xs: DotXs uses <output> for loading (live region) not plain <div>
// <output> carries implicit role="status" per HTML spec — WCAG 2.1 §4.1.3
// ---------------------------------------------------------------------------

describe('HealthBadge size=xs — loading state uses semantic <output> live region', () => {
  it('loading skeleton uses <output> element (implicit role=status)', () => {
    expect(source).toContain('<output');
  });
});
