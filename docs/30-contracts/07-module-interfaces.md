# 07 — Module interfaces

> Assinaturas TypeScript públicas que cada módulo expõe para outros consumirem. **Mudança aqui é breaking change** → exige ADR + atualizar consumidores no mesmo PR (ou marcação `[SYNC-PENDING]` em `MEMORY.md`).

## Convenção

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

type Ctx = {
  workspace_id: string;
  actor_id: string;
  actor_type: 'user' | 'system' | 'api_key';
  request_id: string;
  // ... outros campos de contexto
};
```

Toda função que pode falhar de forma esperada retorna `Result`. Funções `Promise<void>` que falham por exceção: apenas para falhas inesperadas (bug).

---

## MOD-WORKSPACE

```ts
// packages/shared/src/contracts/workspace.ts

export interface WorkspaceModule {
  getWorkspaceById(id: string, ctx: Ctx): Promise<Result<Workspace, NotFound>>;

  requireActiveWorkspace(workspace_id: string, ctx: Ctx):
    Promise<Result<Workspace, WorkspaceSuspended | WorkspaceArchived>>;

  getMemberRole(workspace_id: string, user_id: string):
    Promise<Result<Role, NotMember>>;

  validateApiKeyScope(key_hash: string, required_scope: string, ctx: Ctx):
    Promise<Result<ApiKeyContext, Forbidden>>;

  deriveWorkspaceCryptoKey(workspace_id: string, version: number): Promise<CryptoKey>;
}
```

---

## MOD-LAUNCH

```ts
// packages/shared/src/contracts/launch.ts

export interface LaunchModule {
  getLaunchByPublicId(workspace_id: string, public_id: string, ctx: Ctx):
    Promise<Result<Launch, NotFound>>;

  requireActiveLaunch(launch_id: string, ctx: Ctx):
    Promise<Result<Launch, NotLive | Archived>>;

  getLaunchTrackingConfig(launch_id: string):
    Promise<Result<TrackingConfig, NotFound>>;

  transitionLaunch(launch_id: string, target_status: LaunchStatus, actor: ActorRef, ctx: Ctx):
    Promise<Result<Launch, InvalidTransition>>;
}
```

---

## MOD-PAGE

```ts
// packages/shared/src/contracts/page.ts

export interface PageModule {
  getPageByToken(token_hash: string, ctx: Ctx):
    Promise<Result<{page: Page; launch: Launch; status: PageTokenStatus}, InvalidToken | RevokedToken>>;

  validateOrigin(page: Page, origin_header: string | null):
    Result<void, OriginNotAllowed>;

  rotatePageToken(page_id: string, actor: ActorRef, ctx: Ctx):
    Promise<Result<{new_token_clear: string; new_token_id: string}, InvalidPage>>;

  revokePageToken(token_id: string, actor: ActorRef, ctx: Ctx):
    Promise<Result<void, NotFound>>;

  getActiveTokens(page_id: string, include_rotating: boolean):
    Promise<Result<PageToken[], NotFound>>;
}
```

---

## MOD-IDENTITY

```ts
// packages/shared/src/contracts/identity.ts

export interface IdentityModule {
  resolveLeadByAliases(
    identifiers: { email?: string; phone?: string; external_id?: string },
    workspace_id: string,
    ctx: Ctx,
    options?: { eventTime?: Date }, // T-CONTACTS-LASTSEEN-002 (Sprint 16)
  ): Promise<Result<{
    lead_id: string;
    was_created: boolean;
    merge_executed: boolean;
    merged_lead_ids: string[];
  }, ResolutionError>>;
  // options.eventTime — quando informado, é usado como timestamp do
  //   first_seen_at (caso A — novo lead) e como candidato a last_seen_at via
  //   GREATEST() (casos B — lead existente — e C — merge canônico). Use o
  //   event_time real em paths webhook/replay para que reprocesso não bumpe
  //   last_seen_at para NOW(). Omitir = NOW() (live form submit). `updated_at`
  //   sempre = NOW() (separado de last_seen_at).
  // INV-IDENTITY-LASTSEEN-MONOTONIC: last_seen_at é monotonicamente
  //   não-decrescente — preservado por GREATEST(current, candidate).
  // Call sites que passam eventTime: routes/lead.ts (live form → NOW),
  //   lib/raw-events-processor.ts (payload.event_time),
  //   lib/guru-raw-events-processor.ts (dates.confirmed_at ?? created_at ??
  //   rawEvent.receivedAt), routes/webhooks/sendflow.ts (payload.data.createdAt
  //   com fallback).

  createLeadConsent(
    lead_id: string,
    consent: ConsentSnapshot,
    source: string,
    policy_version: string | null,
    workspace_id: string,
    db: Db,
  ): Promise<Result<LeadConsent, ConsentError>>;

  getLatestConsent(
    lead_id: string,
    finality: ConsentFinality,
    workspace_id: string,
    db: Db,
  ): Promise<Result<ConsentValue, ConsentError>>;

  issueLeadToken(
    lead_id: string,
    page_token_hash: string,
    ttl_days: number,
    ctx: Ctx,
  ): Promise<Result<{token_clear: string; expires_at: string}, IssuanceError>>;

  validateLeadToken(
    token_clear: string,
    current_page_token_hash: string,
    ctx: Ctx,
  ): Promise<Result<{lead_id: string}, InvalidToken | Expired | Revoked | PageMismatch>>;

  revokeLeadToken(token_id: string, actor: ActorRef, ctx: Ctx):
    Promise<Result<void, NotFound>>;

  eraseLead(lead_id: string, actor: ActorRef, ctx: Ctx):
    Promise<Result<{events_anonymized: number; attribution_anonymized: number}, NotFound>>;

  decryptLeadPII(
    lead_id: string,
    fields: Array<'email' | 'phone' | 'name'>,
    actor: ActorRef,
    ctx: Ctx,
  ): Promise<Result<{email?: string; phone?: string; name?: string}, Forbidden>>;

  // ---------------------------------------------------------------------
  // Lead tags (T-LEADS-VIEW-002 — Sprint 16)
  //
  // Atributos binários atemporais por lead, workspace-scoped, complementando
  // lead_stages (progressão monotônica) e events (fatos pontuais).
  // Tag rules vivem no funnel_blueprint (`blueprint.tag_rules`).
  // Ver MOD-IDENTITY § 3 (entidade `lead_tags`).
  // ---------------------------------------------------------------------

  setLeadTag(args: {
    db: Db;
    workspaceId: string;
    leadId: string;
    tagName: string;
    /** 'system' | 'user:<uuid>' | 'integration:<name>' | 'event:<event_name>' */
    setBy: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  // INV-LEAD-TAG-001: UPSERT idempotente via UNIQUE (workspace_id, lead_id,
  //   tag_name) + ON CONFLICT DO NOTHING.
  // INV-LEAD-TAG-002: validação de formato de set_by é responsabilidade do
  //   caller (service-layer) — DB aceita qualquer string para flexibilidade.

  applyTagRules(args: {
    db: Db;
    workspaceId: string;
    leadId: string;
    eventName: string;
    eventContext?: Record<string, unknown>;
    tagRules: Array<{ event: string; when?: Record<string, unknown>; tag: string }> | undefined;
    requestId?: string;
  }): Promise<{ applied: number; skipped: number }>;
  // Lê regras do blueprint, filtra por event + when (AND lógico de keys),
  // chama setLeadTag para cada match. Não levanta — falhas viram log
  // estruturado e contagem skipped++.
}
```

---

## MOD-EVENT

```ts
// packages/shared/src/contracts/event.ts

export interface EventModule {
  acceptRawEvent(payload: unknown, headers: Headers, ctx: Ctx):
    Promise<Result<{event_id: string; status: 'accepted' | 'duplicate_accepted'}, ValidationError | RateLimited>>;

  processRawEvent(raw_event_id: string, ctx: Ctx):
    Promise<Result<{event_id: string; dispatch_jobs_created: number}, ProcessingError>>;

  clampEventTime(event_time: Date, received_at: Date, window_sec: number): Date;

  isReplay(workspace_id: string, event_id: string, ctx: Ctx): Promise<boolean>;

  markReplayProtectionSeen(workspace_id: string, event_id: string, ctx: Ctx): Promise<void>;
}
```

---

## MOD-FUNNEL

```ts
// packages/shared/src/contracts/funnel.ts

export interface FunnelModule {
  recordStage(
    lead_id: string,
    launch_id: string,
    stage: string,
    source_event_id: string | null,
    is_recurring: boolean,
    ctx: Ctx,
  ): Promise<Result<LeadStage, AlreadyRecorded | InvalidStage>>;

  getLeadStages(lead_id: string, launch_id: string): Promise<LeadStage[]>;

  getFunnelSnapshot(launch_id: string, time_range: TimeRange):
    Promise<Array<{stage: string; count: number}>>;
}
```

---

## MOD-ATTRIBUTION

```ts
// packages/shared/src/contracts/attribution.ts

export interface AttributionModule {
  recordTouches(
    input: {
      lead_id: string;
      launch_id: string;
      attribution: AttributionParams;
      event_time: Date;
    },
    ctx: Ctx,
  ): Promise<Result<{first_created: boolean; last_updated: boolean}, RecordingError>>;

  getLinkBySlug(slug: string, ctx: Ctx):
    Promise<Result<Link, NotFound | Archived>>;

  recordLinkClick(link: Link, request_context: SanitizedRequestContext, ctx: Ctx):
    Promise<void>; // fire-and-forget

  getLeadAttribution(lead_id: string, launch_id: string, touch_type: TouchType):
    Promise<LeadAttribution | null>;
}
```

---

## MOD-DISPATCH

```ts
// packages/shared/src/contracts/dispatch.ts

export interface DispatchModule {
  createDispatchJobs(event: Event, ctx: Ctx): Promise<DispatchJob[]>;

  processDispatchJob(job_id: string, ctx: Ctx):
    Promise<Result<DispatchAttempt, ProcessingError>>;

  markDeadLetter(job_id: string, reason: string, ctx: Ctx): Promise<void>;

  requeueDeadLetter(job_id: string, ctx: Ctx):
    Promise<Result<void, NotInDeadLetter>>;

  computeIdempotencyKey(input: {
    workspace_id: string;
    event_id: string;
    destination: DispatchDestination;
    destination_resource_id: string;
    destination_subresource: string;
  }): string;
}
```

---

## MOD-AUDIENCE

```ts
// packages/shared/src/contracts/audience.ts

export interface AudienceModule {
  evaluateAudience(audience_id: string, ctx: Ctx):
    Promise<{member_count: number; snapshot_hash: string; members: string[]}>;

  generateSnapshot(audience_id: string, ctx: Ctx):
    Promise<Result<AudienceSnapshot, NoChange | EvaluationError>>;

  createSyncJob(audience_id: string, snapshot_id: string, ctx: Ctx):
    Promise<Result<AudienceSyncJob, NoConcurrency>>;

  processSyncJob(sync_job_id: string, ctx: Ctx):
    Promise<Result<{additions: number; removals: number}, ProcessingError>>;
}
```

---

## MOD-COST

```ts
// packages/shared/src/contracts/cost.ts

export interface CostModule {
  ingestDailySpend(date: string, ctx: Ctx):
    Promise<{ingested: number; errors: ErrorReport[]}>;

  getNormalizedSpend(
    launch_id: string,
    date_range: TimeRange,
    granularity: Granularity,
    ctx: Ctx,
  ): Promise<AdSpendDaily[]>;

  reprocessFxRetroactive(workspace_id: string, days_back: number, ctx: Ctx):
    Promise<{updated: number}>;
}
```

---

## MOD-ENGAGEMENT

```ts
// packages/shared/src/contracts/engagement.ts

export interface EngagementModule {
  recordSurveyResponse(
    lead_id: string,
    launch_id: string | null,
    survey_id: string,
    response: Record<string, unknown>,
    ctx: Ctx,
  ): Promise<Result<LeadSurveyResponse, InvalidLead>>;

  evaluateIcp(lead_id: string, launch_id: string | null, score_version: string, ctx: Ctx):
    Promise<Result<LeadIcpScore, InvalidLead | InvalidScoreVersion>>;

  recordWebinarAttendance(
    lead_id: string,
    launch_id: string,
    session_id: string,
    attendance: WebinarAttendanceData,
    ctx: Ctx,
  ): Promise<Result<WebinarAttendance, InvalidLead>>;

  getLatestIcpScore(lead_id: string, launch_id: string | null): Promise<LeadIcpScore | null>;
}
```

---

## MOD-AUDIT

```ts
// packages/shared/src/contracts/audit.ts

export interface AuditModule {
  recordAuditEntry(input: {
    workspace_id: string;
    actor_id: string;
    actor_type: AuditActorType;
    action: AuditAction;
    entity_type: string;
    entity_id: string;
    before?: unknown;
    after?: unknown;
    request_context?: unknown;
  }, ctx: Ctx): Promise<void>;

  getAuditLog(filter: {
    workspace_id: string;
    entity_type?: string;
    entity_id?: string;
    action?: AuditAction;
    ts_range?: TimeRange;
  }, ctx: Ctx): Promise<AuditLogEntry[]>;

  purgeRetention(ctx: Ctx): Promise<{purged: number}>;
}
```

---

## MOD-TRACKER

```ts
// API global do bundle (window.Funil)
// Ver apps/tracker/src/index.ts

interface FunilGlobal {
  track(eventName: string, customData?: Record<string, unknown>): void;
  identify(input: { lead_token: string }): void;
  decorate(selectorOrElement: string | HTMLElement): void;
  page(): void;
  logout(): void;
}

declare global {
  interface Window {
    Funil: FunilGlobal;
  }
}
```

---

## Tipos compartilhados

Estão em `packages/shared/src/contracts/types.ts`:

```ts
type ActorRef = { actor_id: string; actor_type: AuditActorType };

type AttributionParams = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbc?: string;
  fbp?: string;
  _gcl_au?: string;
  _ga?: string;
  referrer_domain?: string;
};

type ConsentSnapshot = {
  analytics: ConsentValue;
  marketing: ConsentValue;
  ad_user_data: ConsentValue;
  ad_personalization: ConsentValue;
  customer_match: ConsentValue;
};

type SanitizedRequestContext = {
  request_id: string;
  ip_hash?: string;
  ua_hash?: string;
  origin?: string;
  actor_session_id?: string;
};

type TimeRange = { start: string; end: string };

type ErrorReport = { code: string; message: string; details?: unknown };
```

---

## Política de evolução

1. **Adicionar função nova**: backward-compatible — apenas update de `module-interfaces.md` + implementação.
2. **Adicionar parâmetro opcional**: backward-compatible.
3. **Mudar tipo de retorno (mais campos)**: backward-compatible se for apenas adição.
4. **Mudar tipo de retorno (remover/renomear campo)**: breaking — ADR + atualizar consumidores no mesmo PR.
5. **Renomear função**: deprecation period — manter nome antigo como alias por 1 sprint, então remover.
6. **Remover função**: deprecation explícita + janela de migração + ADR.

Toda mudança breaking nesta página é T-ID `parallel-safe=no`.
