# 01 — Enums canônicos

> **Regra:** todo enum usado em código (TS) ou banco (CHECK constraint) está aqui. Antes de adicionar novo valor a um enum existente: ADR + atualizar consumidores + bumpar `schema_version` se aplicável.

## Identificação de cada enum

| Enum | Arquivo TS | Coluna(s) DB | Módulo dono |
|---|---|---|---|
| `WorkspaceStatus` | `packages/shared/src/contracts/enums.ts` | `workspaces.status` | MOD-WORKSPACE |
| `Role` | mesmo | `workspace_members.role`, `audit_log.actor_type` (parcial) | MOD-WORKSPACE |
| `LaunchStatus` | mesmo | `launches.status` | MOD-LAUNCH |
| `PageRole` | mesmo | `pages.role` | MOD-PAGE |
| `IntegrationMode` | mesmo | `pages.integration_mode` | MOD-PAGE |
| `PageStatus` | mesmo | `pages.status` | MOD-PAGE |
| `PageTokenStatus` | mesmo | `page_tokens.status` | MOD-PAGE |
| `PixelPolicy` | mesmo | `launches.config.tracking.meta.pixel_policy` (jsonb) | MOD-PAGE |
| `LeadStatus` | mesmo | `leads.status` | MOD-IDENTITY |
| `IdentifierType` | mesmo | `lead_aliases.identifier_type` | MOD-IDENTITY |
| `LeadAliasStatus` | mesmo | `lead_aliases.status` | MOD-IDENTITY |
| `MergeReason` | mesmo | `lead_merges.reason` | MOD-IDENTITY |
| `ConsentValue` | mesmo | `lead_consents.consent_*` (5 colunas) | MOD-IDENTITY |
| `ConsentFinality` | mesmo | (chave em consent_snapshot jsonb) | MOD-IDENTITY |
| `EventName` | mesmo | `events.event_name` (não enum estrito — text com lista canônica) | MOD-EVENT |
| `EventSource` | mesmo | `events.event_source` | MOD-EVENT |
| `EventProcessingStatus` | mesmo | `events.processing_status` | MOD-EVENT |
| `RawEventStatus` | mesmo | `raw_events.processing_status` | MOD-EVENT |
| `Stage` | (não-enum estrito — text livre) | `lead_stages.stage` | MOD-FUNNEL |
| `TouchType` | mesmo | `lead_attribution.touch_type` | MOD-ATTRIBUTION |
| `LinkStatus` | mesmo | `links.status` | MOD-ATTRIBUTION |
| `Platform` | mesmo | `audiences.platform`, `ad_spend_daily.platform` | MOD-AUDIENCE / MOD-COST |
| `AudienceDestinationStrategy` | mesmo | `audiences.destination_strategy` | MOD-AUDIENCE |
| `AudienceStatus` | mesmo | `audiences.status` | MOD-AUDIENCE |
| `AudienceSnapshotRetention` | mesmo | `audience_snapshots.retention_status` | MOD-AUDIENCE |
| `SyncJobStatus` | mesmo | `audience_sync_jobs.status` | MOD-AUDIENCE |
| `DispatchDestination` | mesmo | `dispatch_jobs.destination` | MOD-DISPATCH |
| `DispatchStatus` | mesmo | `dispatch_jobs.status` | MOD-DISPATCH |
| `AttemptStatus` | mesmo | `dispatch_attempts.status` | MOD-DISPATCH |
| `Granularity` | mesmo | `ad_spend_daily.granularity` | MOD-COST |
| `FxSource` | mesmo | `ad_spend_daily.fx_source` | MOD-COST |
| `WatchMarker` | mesmo | `webinar_attendance.max_watch_marker` | MOD-ENGAGEMENT |
| `AuditAction` | mesmo | `audit_log.action` (não enum estrito — lista canônica) | MOD-AUDIT |
| `AuditActorType` | mesmo | `audit_log.actor_type` | MOD-AUDIT |

---

## Definições

### `WorkspaceStatus`
```ts
export const WorkspaceStatus = ['active', 'suspended', 'archived'] as const;
export type WorkspaceStatus = typeof WorkspaceStatus[number];
```

### `Role`
```ts
export const Role = ['owner', 'admin', 'marketer', 'operator', 'privacy', 'viewer', 'api_key'] as const;
```
Nota: `api_key` é actor_type, não role humano. Ver `00-product/03-personas-rbac-matrix.md`.

### `LaunchStatus`
```ts
export const LaunchStatus = ['draft', 'configuring', 'live', 'ended', 'archived'] as const;
```

### `PageRole`
```ts
export const PageRole = ['capture', 'sales', 'thankyou', 'webinar', 'checkout', 'survey'] as const;
```

### `IntegrationMode`
```ts
export const IntegrationMode = ['a_system', 'b_snippet', 'c_webhook'] as const;
```

### `PageStatus`
```ts
export const PageStatus = ['draft', 'active', 'paused', 'archived'] as const;
```

### `PageTokenStatus`
```ts
export const PageTokenStatus = ['active', 'rotating', 'revoked'] as const;
```

### `PixelPolicy`
```ts
export const PixelPolicy = ['server_only', 'browser_and_server_managed', 'coexist_with_existing_pixel'] as const;
```

### `LeadStatus`
```ts
export const LeadStatus = ['active', 'merged', 'erased'] as const;
```

### `IdentifierType`
```ts
export const IdentifierType = ['email_hash', 'phone_hash', 'external_id_hash', 'lead_token_id'] as const;
```

### `LeadAliasStatus`
```ts
export const LeadAliasStatus = ['active', 'superseded', 'revoked'] as const;
```

### `MergeReason`
```ts
export const MergeReason = ['email_phone_convergence', 'manual', 'sar'] as const;
```

### `ConsentValue`
```ts
export const ConsentValue = ['granted', 'denied', 'unknown'] as const;
```

### `ConsentFinality`
```ts
export const ConsentFinality = ['analytics', 'marketing', 'ad_user_data', 'ad_personalization', 'customer_match'] as const;
```

### `EventName` (lista canônica, não enum estrito — eventos custom permitidos)
```ts
export const CanonicalEventName = [
  'PageView', 'Lead', 'Contact', 'ViewContent',
  'InitiateCheckout', 'AddPaymentInfo', 'Purchase',
  'CompleteRegistration', 'Subscribe', 'StartTrial',
  'Schedule', 'Search', 'AddToCart', 'AddToWishlist',
  'CustomEvent',
] as const;
```
Eventos custom têm prefixo `custom:` (ex.: `custom:webinar_q_asked`). Validador rejeita nomes ambíguos.

### `EventSource`
```ts
export const EventSource = [
  'tracker',
  'webhook:hotmart', 'webhook:kiwify', 'webhook:stripe',
  'webhook:webinarjam', 'webhook:typeform', 'webhook:tally',
  'redirector', 'system', 'admin',
] as const;
```

### `EventProcessingStatus`
```ts
export const EventProcessingStatus = ['accepted', 'enriched', 'rejected_archived_launch', 'rejected_consent', 'rejected_validation'] as const;
```

### `RawEventStatus`
```ts
export const RawEventStatus = ['pending', 'processed', 'failed', 'discarded'] as const;
```

### `TouchType`
```ts
export const TouchType = ['first', 'last', 'all'] as const;
```

### `LinkStatus`
```ts
export const LinkStatus = ['active', 'archived'] as const;
```

### `Platform`
```ts
export const Platform = ['meta', 'google'] as const;
```

### `AudienceDestinationStrategy`
```ts
export const AudienceDestinationStrategy = [
  'meta_custom_audience',
  'google_data_manager',
  'google_ads_api_allowlisted',
  'disabled_not_eligible',
] as const;
```

### `AudienceStatus`
```ts
export const AudienceStatus = ['draft', 'active', 'paused', 'archived'] as const;
```

### `AudienceSnapshotRetention`
```ts
export const AudienceSnapshotRetention = ['active', 'archived', 'purged'] as const;
```

### `SyncJobStatus`
```ts
export const SyncJobStatus = ['pending', 'processing', 'succeeded', 'failed'] as const;
```

### `DispatchDestination`
```ts
export const DispatchDestination = [
  'meta_capi',
  'ga4_mp',
  'google_ads_conversion',
  'google_enhancement',
  'audience_sync',
] as const;
```

### `DispatchStatus`
```ts
export const DispatchStatus = [
  'pending', 'processing', 'succeeded',
  'retrying', 'failed', 'skipped', 'dead_letter',
] as const;
```

### `AttemptStatus`
```ts
export const AttemptStatus = ['succeeded', 'retryable_failure', 'permanent_failure'] as const;
```

### `Granularity`
```ts
export const Granularity = ['account', 'campaign', 'adset', 'ad'] as const;
```

### `FxSource`
```ts
export const FxSource = ['ecb', 'wise', 'manual'] as const;
```

### `WatchMarker`
```ts
export const WatchMarker = ['25%', '50%', '75%', '100%', 'completed'] as const;
```

### `AuditAction` (lista canônica)
```ts
export const AuditAction = [
  'create', 'update', 'delete',
  'rotate', 'revoke',
  'erase_sar', 'merge_leads',
  'read_pii_decrypted',
  'sync_audience',
  'reprocess_dlq',
] as const;
```

### `AuditActorType`
```ts
export const AuditActorType = ['user', 'system', 'api_key'] as const;
```

---

## Política de evolução de enum

1. **Adicionar valor novo:** ADR + atualizar `01-enums.md` + atualizar Zod schemas em `packages/shared/` + adicionar valor à constraint CHECK do DB via migration. Idealmente novo valor não quebra consumidores antigos.
2. **Remover valor:** ADR de superseded + plano de migração (data com valor sendo deprecated → migration que move para valor novo). **Nunca** remover valor sem migration prévia.
3. **Renomear valor:** equivale a remover + adicionar; mesmo cuidado.
4. **Mudança breaking:** bumpar `schema_version` no contrato afetado e seguir política de versionamento (`/v1` → `/v2` quando público).

Cada mudança de enum é uma T-ID `parallel-safe=no` na onda — porque mexe em `30-contracts/`.
