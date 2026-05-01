# Companies

## Mission
Create implementation-ready, token-driven UI guidance for Companies that is optimized for consistency, accessibility, and fast delivery across dashboard web app.

## Brand
- Product/brand: Companies
- URL: https://app.attio.com/cne/companies/view/f44a7037-df91-42ea-bd61-e13fea3d3d6b
- Audience: authenticated users and operators
- Product surface: dashboard web app

## Style Foundations
- Visual style: clean, functional, implementation-oriented
- Main font style: `font.family.primary=Inter`, `font.family.stack=Inter, sans-serif`, `font.size.base=10px`, `font.weight.base=400`, `font.lineHeight.base=15px`
- Typography scale: `font.size.xs=10px`, `font.size.sm=14px`
- Color palette: `color.text.primary=#ffffff`, `color.text.secondary=#9e9eff`, `color.text.tertiary=#4e8cfc`, `color.surface.base=#000000`, `color.surface.muted=#1a1d21`, `color.surface.strong=#15181c`
- Spacing scale: `space.1=1px`, `space.2=2px`, `space.3=3px`, `space.4=4px`, `space.5=6px`, `space.6=7px`, `space.7=8px`, `space.8=10px`
- Radius/shadow/motion tokens: `radius.xs=6px`, `radius.sm=7px`, `radius.md=8px`, `radius.lg=9px`, `radius.xl=10px`, `radius.2xl=18px` | `shadow.1=rgb(47, 48, 51) 0px 0px 0px 1px inset, rgb(0, 0, 0) 0px 0px 2px 0px, rgba(0, 0, 0, 0.08) 0px 1px 3px 0px`, `shadow.2=rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset, rgba(78, 140, 252, 0.12) 0px 2px 4px -2px, rgba(78, 140, 252, 0.08) 0px 3px 6px -2px`, `shadow.3=rgb(47, 48, 51) 0px 0px 0px 1px inset` | `motion.duration.instant=100ms`, `motion.duration.fast=140ms`, `motion.duration.normal=160ms`, `motion.duration.slow=200ms`

## Accessibility
- Target: WCAG 2.2 AA
- Keyboard-first interactions required.
- Focus-visible rules required.
- Contrast constraints required.

## Writing Tone
Concise, confident, implementation-focused.

## Rules: Do
- Use semantic tokens, not raw hex values, in component guidance.
- Every component must define states for default, hover, focus-visible, active, disabled, loading, and error.
- Component behavior should specify responsive and edge-case handling.
- Interactive components must document keyboard, pointer, and touch behavior.
- Accessibility acceptance criteria must be testable in implementation.

## Rules: Don't
- Do not allow low-contrast text or hidden focus indicators.
- Do not introduce one-off spacing or typography exceptions.
- Do not use ambiguous labels or non-descriptive actions.
- Do not ship component guidance without explicit state rules.

## Guideline Authoring Workflow
1. Restate design intent in one sentence.
2. Define foundations and semantic tokens.
3. Define component anatomy, variants, interactions, and state behavior.
4. Add accessibility acceptance criteria with pass/fail checks.
5. Add anti-patterns, migration notes, and edge-case handling.
6. End with a QA checklist.

## Required Output Structure
- Context and goals.
- Design tokens and foundations.
- Component-level rules (anatomy, variants, states, responsive behavior).
- Accessibility requirements and testable acceptance criteria.
- Content and tone standards with examples.
- Anti-patterns and prohibited implementations.
- QA checklist.

## Component Rule Expectations
- Include keyboard, pointer, and touch behavior.
- Include spacing and typography token requirements.
- Include long-content, overflow, and empty-state handling.
- Include known page component density: links (106), buttons (85), navigation (2), lists (2).

- Extraction diagnostics: Limited typography variety detected; size scale may need manual refinement.

## Quality Gates
- Every non-negotiable rule must use "must".
- Every recommendation should use "should".
- Every accessibility rule must be testable in implementation.
- Teams should prefer system consistency over local visual exceptions.
