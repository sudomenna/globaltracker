# 03 — Personas e RBAC

## Personas

### PERSONA-MARKETER — Profissional de marketing

- **Quem é:** especialista em performance/aquisição que opera lançamentos de infoprodutos no dia-a-dia. Configura campanhas Meta/Google, monta funis, decora links, acompanha CPL/CPA/ROAS, ajusta criativos e orçamentos.
- **Objetivo no produto:** centralizar configuração, acompanhar performance em tempo real, identificar gargalos de funil, sincronizar audiences sem retrabalho a cada lançamento.
- **Frustração principal:** configurar tracking duplicado em GTM + Pixel + Server Events Manager + plataforma de checkout a cada lançamento; ROAS impreciso por eventos faltantes; audience que não sincroniza sem mensagem clara.
- **Frequência de uso:** diária durante lançamento ativo; semanal entre lançamentos.

### PERSONA-OPERATOR — Dev/operador interno

- **Quem é:** desenvolvedor ou DevOps interno responsável por configuração técnica do GlobalTracker (domínios, DNS, secrets, deploys, integrações novas).
- **Objetivo no produto:** manter o Runtime estável, instalar adapters novos quando time precisa de plataforma nova de checkout, rotacionar credenciais com segurança.
- **Frustração principal:** secrets espalhados em vários lugares; debugging de webhook quando assinatura falha; logs com PII vazando.
- **Frequência de uso:** semanal (ajustes); diária durante incidentes ou deploy de novo lançamento.

### PERSONA-LEAD — Visitante/lead capturado

- **Quem é:** o sujeito do tracking. Visita LP, preenche form, recebe email de marketing, faz checkout, retorna em sessões futuras.
- **Objetivo no produto:** comprar o produto que está procurando, com privacidade respeitada e consent claro.
- **Frustração principal:** receber tracking invasivo sem opção clara de consent; ver PII vazada em URL ou email.
- **Frequência de uso:** episódica (durante o ciclo do funil — 1–30 dias).
- **Nota:** PERSONA-LEAD não tem login no sistema; interage indiretamente via tracker.js e formulários.

### PERSONA-PRIVACY-OFFICER — Operador de privacidade

- **Quem é:** profissional de compliance/jurídico responsável por LGPD/GDPR no workspace. Recebe Subject Access Requests (SAR), audita políticas de retenção, garante prova de consent.
- **Objetivo no produto:** executar SAR/erasure rapidamente; verificar `audit_log`; ajustar políticas de retenção; obter relatórios de consent.
- **Frustração principal:** PII espalhada em múltiplos sistemas sem ferramenta unificada de erasure; falta de prova auditável de consent histórico.
- **Frequência de uso:** mensal (rotina); ad-hoc quando recebe SAR (geralmente < 30 dias para responder).

---

## Roles

### ROLE-OWNER

- **Quem assume:** dono(a) da operação (pessoa que contratou ou criou o workspace).
- **Permissões:** todas as ações de qualquer outro role + billing + criar/destruir workspace + gerenciar membros.
- **Limitações:** nenhuma dentro do próprio workspace; cross-workspace é impossível mesmo para Owner (ADR-002).

### ROLE-ADMIN

- **Quem assume:** PERSONA-OPERATOR sênior ou PERSONA-MARKETER líder.
- **Permissões:** todas as ações operacionais + gerenciar membros (exceto promoção a Owner) + executar SAR.
- **Limitações:** não pode mexer em billing nem dissolver workspace. Promoção a Owner exige ação do Owner.

### ROLE-MARKETER

- **Quem assume:** PERSONA-MARKETER.
- **Permissões:** CRUD em launches, pages, links, audiences, integrations de mídia (Meta/Google credentials read-only após criação). Read em events, dispatch_jobs, dashboards.
- **Limitações:** não vê PII em claro em nenhum recurso. Não pode executar SAR/erasure. Não rotaciona page tokens (apenas Operator/Admin).

### ROLE-OPERATOR

- **Quem assume:** PERSONA-OPERATOR.
- **Permissões:** CRUD em integrations (Meta/Google/webhooks) + secrets references + page tokens (rotacionar/revogar) + monitoring/observabilidade. Read em events e dispatch para debug.
- **Limitações:** não cria/edita launches ou audiences (responsabilidade de Marketer). Não vê PII em claro a não ser durante debug autorizado de evento específico.

### ROLE-PRIVACY

- **Quem assume:** PERSONA-PRIVACY-OFFICER.
- **Permissões:** Read em PII em claro de leads (com audit log automático de cada acesso). CRUD em SAR/erasure jobs. Read em `audit_log`. Configurar políticas de retenção.
- **Limitações:** não cria/edita launches, pages, audiences. Não tem acesso a integrations credentials. Cada acesso a PII gera entry em audit_log.

### ROLE-VIEWER

- **Quem assume:** stakeholder externo, executivo, cliente do operador (quando GlobalTracker é vendido como ferramenta para terceiros).
- **Permissões:** Read em dashboards e métricas agregadas. Read em launches, pages, links (sem ver page_tokens).
- **Limitações:** **nunca** vê PII (em claro ou criptografada). Não vê eventos individuais. Não vê `dispatch_jobs` com payloads.

### ROLE-API_KEY

- **Quem assume:** sistema externo autorizado pelo Owner/Admin (ex.: integração custom server-to-server).
- **Permissões:** scoped por chave — cada chave declara escopos como `events:write`, `leads:erase`, `audiences:read`. Sem login interativo.
- **Limitações:** rate limit dedicado. Não tem acesso a UI. Action é sempre logada em `audit_log` com `actor_type='api_key'` e identificador da chave.

---

## Matriz CRUD

Convenções:

- `C` = Create
- `R` = Read (todos os campos)
- `Rs` = Read sanitizado (sem PII em claro)
- `U` = Update
- `D` = Delete (lógico — soft-delete onde aplicável)
- `−` = sem permissão
- `Próprio` = só registros que o próprio role criou

| Recurso | Owner | Admin | Marketer | Operator | Privacy | Viewer | API_KEY (scoped) |
|---|---|---|---|---|---|---|---|
| **Workspace** | CRUD | RU | R | R | R | R | scoped |
| **Members (gerenciar)** | CRUD | CRU | − | − | − | − | scoped |
| **Billing** | CRUD | R | − | − | − | − | − |
| **Launch** | CRUD | CRUD | CRUD | R | R | R | scoped |
| **Page** | CRUD | CRUD | CRUD | RU | R | Rs (sem token) | scoped |
| **PageToken** | CRUD | CRUD | R (hash) | CRUD | R | − | scoped |
| **Link** | CRUD | CRUD | CRUD | R | R | Rs | scoped |
| **Audience (definição)** | CRUD | CRUD | CRUD | R | R | Rs | scoped |
| **AudienceSnapshot/Members** | R | R | R | R | R | − | scoped |
| **AudienceSyncJob** | CR (trigger) | CR | CR | R | R | − | scoped |
| **Lead (PII enc)** | R | R | Rs (hash) | Rs (hash) | R (decrypt + audit) | − | scoped (write only) |
| **Lead (PII em claro: email/phone)** | R | R | R | R (mascarado por padrão; reveal on-demand + audit) | R (audit log) | − | − |
| **Lead (name plaintext, ADR-034)** | R | R | R | R | R | − | − |
| **LeadAlias** | R | R | R | R | R | − | scoped |
| **LeadMerge** | R | R | R | R | R | − | scoped |
| **LeadConsent** | R | R | R | R | R | − | scoped |
| **LeadToken (claim)** | − | − | − | − | − | − | sistema apenas |
| **Event** | R | R | Rs (sem user_data PII) | R (debug) | R | − | scoped (write) |
| **RawEvent** | R (debug) | R (debug) | − | R (debug) | R (audit) | − | scoped (write) |
| **DispatchJob** | R | R | R | R | R | − | scoped |
| **DispatchAttempt** | R | R | R | R | R | − | scoped |
| **AdSpendDaily** | R | RU (corrigir manual) | R | RU (corrigir manual) | R | R | scoped |
| **SurveyResponse** | R | R | R | − | R | − | scoped (write) |
| **WebinarAttendance** | R | R | R | − | R | − | scoped (write) |
| **AuditLog** | R | R | R (próprio) | R (próprio) | R | − | − (sistema apenas) |
| **IntegrationCredential** | CRUD (write-only secrets) | CRUD (write-only) | R (referência apenas) | CRUD (write-only) | − | − | − |
| **WebhookConfig** | CRUD | CRUD | R | CRUD | − | − | scoped |
| **Cron schedule** | RU | RU | − | RU | − | − | − |
| **DLQ messages** | R | R | − | R | − | − | scoped |
| **SAR/Erasure job** | CR | CR | − | − | CRUD (executar) | − | scoped (`leads:erase`) |
| **Retention policy** | RU | RU | − | − | RU | − | − |
| **Dashboard (Metabase)** | R | R | R | R | R | R | − |

---

## Regras de acesso (AUTHZ-*)

### AUTHZ-001 — Lead PII em claro: matriz por role + audit (ampliado por ADR-034)

Acesso a `leads.email_enc` / `leads.phone_enc` decifrados segue a matriz abaixo. `leads.name` deixou de ser cifrado (ADR-034) e é plaintext em todas roles exceto Viewer.

| Role | email/phone em claro | Audit em toda decifragem |
|---|---|---|
| `owner` | sim, sempre | não (acesso natural) |
| `admin` | sim, sempre | não |
| `marketer` | sim, sempre | não |
| `privacy` | sim, sempre | sim |
| `operator` | mascarado por padrão; reveal on-demand via `POST /v1/leads/:id/reveal-pii` | sim, on reveal |
| `viewer` | nunca; reveal retorna 403 | n/a (sempre denied) |

Tentativa de reveal por `viewer` retorna 403 + audit `read_pii_decrypted_denied`.

### AUTHZ-002 — PageToken só pode ser rotacionado por Owner/Admin/Operator

Ação `rotate` em `page_tokens` exige role `owner`, `admin` ou `operator`. Marketer não tem permissão — porque rotação errada quebra snippets em produção, e Marketer geralmente não opera DNS/snippets. Audit log obrigatório.

### AUTHZ-003 — SAR/erasure exige ROLE-PRIVACY ou ROLE-ADMIN com double-confirm

`DELETE /v1/admin/leads/:lead_id` exige role `privacy` ou `admin`. UI apresenta double-confirm (digite "ERASE LEAD <id>" para confirmar). Audit log entry com `action='erase_sar'` é obrigatório. Operação irreversível — ADR-014 documenta política.

### AUTHZ-004 — `audit_log` é apenas-leitura para todos os roles humanos

Nenhum role pode INSERT/UPDATE/DELETE em `audit_log` via UI ou API. Apenas o sistema (server-to-server interno) escreve. Rotina de purge segue retenção de 7 anos (ADR-014).

### AUTHZ-005 — Cross-workspace queries são proibidas em qualquer role

Mesmo `owner` não pode ler dados de outro workspace. RLS no Postgres + filtro explícito em todo query handler garante isolamento. Owner vê apenas seu próprio workspace; gerenciamento cross-workspace requer admin do GlobalTracker (super-admin operacional, fora do escopo do RBAC interno).

### AUTHZ-006 — Integration credentials são write-only após criação

`META_CAPI_TOKEN`, `GOOGLE_ADS_REFRESH_TOKEN`, secrets de webhook são **write-only**: UI permite criar/atualizar mas nunca exibe valor após salvar. Marketer vê apenas referência (`secret_id`, `last_4`, `created_at`). Operator atualiza valor; Marketer não.

### AUTHZ-007 — Marketer não pode editar consent gravado

Marketer pode apenas **registrar** novos consents (via captura em formulário). Não pode UPDATE em `lead_consents` para marcar `granted` retroativamente. Operação só permitida a `owner` ou `privacy` com audit log.

### AUTHZ-008 — Viewer nunca vê PII em circunstância alguma

Viewer recebe sempre versão sanitizada de leads (apenas `lead_public_id`, `first_seen_at`, `last_seen_at` sem identificadores). Tentativa de query a `leads.email_*` retorna 403. Viewer existe especificamente para apresentação a stakeholder sem acesso a dados pessoais.

### AUTHZ-009 — API_KEY tem escopo declarado e rate limit dedicado

Cada API key tem `scopes: text[]` (ex.: `['events:write', 'leads:read', 'audiences:write']`). Operação fora do escopo retorna 403. Cada chave tem rate limit independente do workspace para evitar abuse + visibilidade granular em monitoring.

### AUTHZ-010 — Operator pode ler RawEvent para debug, com retention de visibilidade

`raw_events` pode ser consultado por Operator para debug, mas a tabela é purgada após 7 dias (ADR-014). Acesso fora dessa janela exige reprocessamento via DLQ.

### AUTHZ-011 — Privacy não tem acesso a IntegrationCredentials

Privacy Officer não precisa de credenciais Meta/Google para fazer seu trabalho. Separação reduz superfície de ataque social engineering.

### AUTHZ-012 — Cross-cutting: toda mutação registra em `audit_log`

Operações INSERT/UPDATE/DELETE em `pages.event_config`, `audiences.query_definition`, `page_tokens`, `lead_consents`, `retention_policies`, `integration_credentials` (referência) **DEVEM** gerar `audit_log` entry, independente do role que executou.

---

## Mapeamento Persona → Role(s) primário(s)

| Persona | Role primário | Role secundário (eventual) |
|---|---|---|
| PERSONA-MARKETER | ROLE-MARKETER | ROLE-ADMIN (líder do time) |
| PERSONA-OPERATOR | ROLE-OPERATOR | ROLE-ADMIN (DevOps lead) |
| PERSONA-PRIVACY-OFFICER | ROLE-PRIVACY | ROLE-ADMIN (em workspaces pequenos) |
| PERSONA-LEAD | n/a (não loga) | n/a |

`ROLE-OWNER` é tipicamente o(a) dono(a) da operação (pode ser uma persona não modelada explicitamente — "C-level / business owner"). `ROLE-VIEWER` é tipicamente cliente externo do operador. `ROLE-API_KEY` é sistema, não pessoa.
