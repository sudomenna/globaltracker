/**
 * rbac.ts — Role hierarchy and PII access policy (ADR-034 / BR-IDENTITY-006).
 *
 * Roles canônicos do GlobalTracker (BR-RBAC):
 *   owner > admin > marketer > privacy > operator > viewer
 *
 * "Higher" role does NOT imply "lower" permissions automatically — each
 * permission is a discrete check. This module exposes only the PII access
 * predicates needed by the leads endpoints.
 */

export type WorkspaceRole =
  | 'owner'
  | 'admin'
  | 'marketer'
  | 'privacy'
  | 'operator'
  | 'viewer';

export const VALID_ROLES: ReadonlySet<string> = new Set<WorkspaceRole>([
  'owner',
  'admin',
  'marketer',
  'privacy',
  'operator',
  'viewer',
]);

export function isValidRole(role: string | null | undefined): role is WorkspaceRole {
  return typeof role === 'string' && VALID_ROLES.has(role);
}

/**
 * ADR-034: roles que veem PII (email/phone) em claro por padrão na lista
 * sem audit. Privacy também vê em claro mas com audit obrigatório.
 */
const PII_PLAINTEXT_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
  'owner',
  'admin',
  'marketer',
  'privacy',
]);

/**
 * Pode ver email/phone em claro na lista por padrão.
 */
export function canSeePiiPlainByDefault(role: WorkspaceRole | null): boolean {
  if (!role) return false;
  return PII_PLAINTEXT_ROLES.has(role);
}

/**
 * Pode invocar reveal-on-demand (gera audit log).
 * Operator pode; viewer não.
 */
export function canRevealPii(role: WorkspaceRole | null): boolean {
  if (!role) return false;
  // Privacy/owner/admin/marketer já veem em claro — reveal é redundante mas
  // o endpoint pode ser chamado por eles. Apenas viewer fica fora.
  return role !== 'viewer';
}

/**
 * Privacy é o único role que requer audit log também na leitura natural
 * (não só on-demand).
 */
export function requiresAuditOnNaturalRead(role: WorkspaceRole | null): boolean {
  return role === 'privacy';
}
