// Canonical enums for GlobalTracker — source of truth for TS and DB CHECK constraints.
// Any addition requires: ADR + update docs/30-contracts/01-enums.md + migration (see §7 AGENTS.md).

// MOD-WORKSPACE
export const WorkspaceStatus = ['active', 'suspended', 'archived'] as const;
export type WorkspaceStatus = (typeof WorkspaceStatus)[number];

// MOD-WORKSPACE — note: 'api_key' is an actor_type, not a human role (see personas-rbac-matrix)
export const Role = [
  'owner',
  'admin',
  'marketer',
  'operator',
  'privacy',
  'viewer',
  'api_key',
] as const;
export type Role = (typeof Role)[number];

// MOD-LAUNCH
export const LaunchStatus = [
  'draft',
  'configuring',
  'live',
  'ended',
  'archived',
] as const;
export type LaunchStatus = (typeof LaunchStatus)[number];

// MOD-PAGE
export const PageRole = [
  'capture',
  'sales',
  'thankyou',
  'webinar',
  'checkout',
  'survey',
] as const;
export type PageRole = (typeof PageRole)[number];

// MOD-PAGE
export const IntegrationMode = ['a_system', 'b_snippet', 'c_webhook'] as const;
export type IntegrationMode = (typeof IntegrationMode)[number];

// MOD-PAGE
export const PageStatus = ['draft', 'active', 'paused', 'archived'] as const;
export type PageStatus = (typeof PageStatus)[number];

// MOD-PAGE
export const PageTokenStatus = ['active', 'rotating', 'revoked'] as const;
export type PageTokenStatus = (typeof PageTokenStatus)[number];

// MOD-PAGE — stored in launches.config.tracking.meta.pixel_policy (jsonb)
export const PixelPolicy = [
  'server_only',
  'browser_and_server_managed',
  'coexist_with_existing_pixel',
] as const;
export type PixelPolicy = (typeof PixelPolicy)[number];

// MOD-IDENTITY
export const LeadStatus = ['active', 'merged', 'erased'] as const;
export type LeadStatus = (typeof LeadStatus)[number];

// MOD-IDENTITY
export const IdentifierType = [
  'email_hash',
  'phone_hash',
  'external_id_hash',
  'lead_token_id',
] as const;
export type IdentifierType = (typeof IdentifierType)[number];

// MOD-IDENTITY
export const LeadAliasStatus = ['active', 'superseded', 'revoked'] as const;
export type LeadAliasStatus = (typeof LeadAliasStatus)[number];

// MOD-IDENTITY
export const MergeReason = [
  'email_phone_convergence',
  'manual',
  'sar',
] as const;
export type MergeReason = (typeof MergeReason)[number];

// MOD-IDENTITY
export const ConsentValue = ['granted', 'denied', 'unknown'] as const;
export type ConsentValue = (typeof ConsentValue)[number];

// MOD-IDENTITY — key in consent_snapshot jsonb
export const ConsentFinality = [
  'analytics',
  'marketing',
  'ad_user_data',
  'ad_personalization',
  'customer_match',
] as const;
export type ConsentFinality = (typeof ConsentFinality)[number];

// MOD-EVENT — not a strict enum; custom events use prefix 'custom:' (e.g., 'custom:webinar_q_asked')
export const CanonicalEventName = [
  'PageView',
  'Lead',
  'Contact',
  'ViewContent',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Purchase',
  'CompleteRegistration',
  'Subscribe',
  'StartTrial',
  'Schedule',
  'Search',
  'AddToCart',
  'AddToWishlist',
  'CustomEvent',
] as const;
export type CanonicalEventName = (typeof CanonicalEventName)[number];

// MOD-EVENT
export const EventSource = [
  'tracker',
  'webhook:hotmart',
  'webhook:kiwify',
  'webhook:stripe',
  'webhook:webinarjam',
  'webhook:typeform',
  'webhook:tally',
  'redirector',
  'system',
  'admin',
] as const;
export type EventSource = (typeof EventSource)[number];

// MOD-EVENT
export const EventProcessingStatus = [
  'accepted',
  'enriched',
  'rejected_archived_launch',
  'rejected_consent',
  'rejected_validation',
] as const;
export type EventProcessingStatus = (typeof EventProcessingStatus)[number];

// MOD-EVENT
export const RawEventStatus = [
  'pending',
  'processed',
  'failed',
  'discarded',
] as const;
export type RawEventStatus = (typeof RawEventStatus)[number];

// MOD-ATTRIBUTION
export const TouchType = ['first', 'last', 'all'] as const;
export type TouchType = (typeof TouchType)[number];

// MOD-ATTRIBUTION
export const LinkStatus = ['active', 'archived'] as const;
export type LinkStatus = (typeof LinkStatus)[number];

// MOD-AUDIENCE / MOD-COST
export const Platform = ['meta', 'google'] as const;
export type Platform = (typeof Platform)[number];

// MOD-AUDIENCE
export const AudienceDestinationStrategy = [
  'meta_custom_audience',
  'google_data_manager',
  'google_ads_api_allowlisted',
  'disabled_not_eligible',
] as const;
export type AudienceDestinationStrategy =
  (typeof AudienceDestinationStrategy)[number];

// MOD-AUDIENCE
export const AudienceStatus = [
  'draft',
  'active',
  'paused',
  'archived',
] as const;
export type AudienceStatus = (typeof AudienceStatus)[number];

// MOD-AUDIENCE
export const AudienceSnapshotRetention = [
  'active',
  'archived',
  'purged',
] as const;
export type AudienceSnapshotRetention =
  (typeof AudienceSnapshotRetention)[number];

// MOD-AUDIENCE
export const SyncJobStatus = [
  'pending',
  'processing',
  'succeeded',
  'failed',
] as const;
export type SyncJobStatus = (typeof SyncJobStatus)[number];

// MOD-DISPATCH
export const DispatchDestination = [
  'meta_capi',
  'ga4_mp',
  'google_ads_conversion',
  'google_enhancement',
  'audience_sync',
] as const;
export type DispatchDestination = (typeof DispatchDestination)[number];

// MOD-DISPATCH
export const DispatchStatus = [
  'pending',
  'processing',
  'succeeded',
  'retrying',
  'failed',
  'skipped',
  'dead_letter',
] as const;
export type DispatchStatus = (typeof DispatchStatus)[number];

// MOD-DISPATCH
export const AttemptStatus = [
  'succeeded',
  'retryable_failure',
  'permanent_failure',
] as const;
export type AttemptStatus = (typeof AttemptStatus)[number];

// MOD-COST
export const Granularity = ['account', 'campaign', 'adset', 'ad'] as const;
export type Granularity = (typeof Granularity)[number];

// MOD-COST
export const FxSource = ['ecb', 'wise', 'manual'] as const;
export type FxSource = (typeof FxSource)[number];

// MOD-ENGAGEMENT
export const WatchMarker = ['25%', '50%', '75%', '100%', 'completed'] as const;
export type WatchMarker = (typeof WatchMarker)[number];

// MOD-AUDIT — canonical list; not a strict DB enum
export const AuditAction = [
  'create',
  'update',
  'delete',
  'rotate',
  'revoke',
  'erase_sar',
  'merge_leads',
  'read_pii_decrypted',
  'sync_audience',
  'reprocess_dlq',
] as const;
export type AuditAction = (typeof AuditAction)[number];

// MOD-AUDIT
export const AuditActorType = ['user', 'system', 'api_key'] as const;
export type AuditActorType = (typeof AuditActorType)[number];
