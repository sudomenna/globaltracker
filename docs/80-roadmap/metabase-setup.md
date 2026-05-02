# Metabase Setup — GlobalTracker

Conectar o Metabase ao banco Supabase (Postgres) e montar o dashboard inicial de performance.

---

## 1. Criar usuário read-only no Supabase

Execute no SQL Editor do Supabase (projeto `kaxcmhfaqrxwnpftkslj`):

```sql
CREATE USER metabase_ro WITH PASSWORD '<senha_forte>';
GRANT CONNECT ON DATABASE postgres TO metabase_ro;
GRANT USAGE ON SCHEMA public TO metabase_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO metabase_ro;
```

Substitua `<senha_forte>` por uma senha gerada (mínimo 32 caracteres, alfanumérica + símbolos). Guarde no gerenciador de segredos da equipe — nunca no repositório.

---

## 2. Obter as credenciais de conexão

No painel do Supabase, acesse **Project Settings > Database > Connection string**.

Use o **Session Pooler** (não o Transaction Pooler) para conexões externas persistentes como o Metabase:

| Campo    | Valor                                                  |
|----------|--------------------------------------------------------|
| Host     | `aws-0-sa-east-1.pooler.supabase.com`                  |
| Porta    | `5432`                                                 |
| Database | `postgres`                                             |
| User     | `metabase_ro`                                          |
| Password | `<senha_forte>` definida no passo anterior             |
| SSL      | Obrigatório (`require`)                                |

O Session Pooler mantém conexões de longa duração compatíveis com o comportamento de conexão do Metabase. O Transaction Pooler (porta 6543) deve ser evitado aqui.

---

## 3. Instalar o Metabase

### Opção A — Docker (self-hosted)

```bash
docker run -d \
  -p 3000:3000 \
  --name metabase \
  -e "MB_DB_TYPE=h2" \
  metabase/metabase:latest
```

Acesse `http://localhost:3000` e complete o wizard de setup inicial.

Para produção, substitua `MB_DB_TYPE=h2` por um banco Postgres dedicado para os metadados do Metabase (separado do banco do GlobalTracker).

### Opção B — Metabase Cloud

Crie uma conta em [https://www.metabase.com/cloud/](https://www.metabase.com/cloud/) e pule diretamente para o passo 4.

---

## 4. Adicionar a conexão no Metabase

1. Acesse **Admin > Databases > Add database**.
2. Selecione **PostgreSQL**.
3. Preencha os campos com os valores do passo 2.
4. Marque **Use a secure connection (SSL)**.
5. Clique em **Save**.

O Metabase sincronizará o schema automaticamente. As views `daily_funnel_rollup`, `ad_performance_rollup` e `dispatch_health_view` aparecem como tabelas normais no browser.

---

## 5. Sincronizar o schema manualmente (se necessário)

Se as views não aparecerem imediatamente:

**Admin > Databases > GlobalTracker > Sync database schema now**

Repita após criar novas views ou alterar colunas existentes.

---

## 6. Dashboard inicial — perguntas sugeridas

Crie uma nova Collection chamada `Performance` e adicione as perguntas abaixo. Agrupe-as num dashboard chamado `Performance Overview`.

### 6.1 CPL por campanha

**Fonte:** `ad_performance_rollup`

Filtros sugeridos: `launch_id`, intervalo de `date`.

```sql
SELECT
  campaign_id,
  platform,
  SUM(cost_per_lead_cents) / 100.0 AS cpl_brl
FROM ad_performance_rollup
WHERE launch_id = {{launch_id}}
  AND date BETWEEN {{start_date}} AND {{end_date}}
GROUP BY campaign_id, platform
ORDER BY cpl_brl ASC;
```

Visualização recomendada: tabela ou bar chart com `campaign_id` no eixo X.

---

### 6.2 ROAS diário por plataforma

**Fonte:** `ad_performance_rollup`

```sql
SELECT
  date,
  platform,
  AVG(roas) AS roas_medio
FROM ad_performance_rollup
WHERE launch_id = {{launch_id}}
GROUP BY date, platform
ORDER BY date ASC;
```

Visualização recomendada: line chart com `date` no eixo X, série por `platform`.

---

### 6.3 Funil de conversão

**Fonte:** `daily_funnel_rollup`

```sql
SELECT
  day,
  event_name,
  SUM(count) AS total
FROM daily_funnel_rollup
WHERE launch_id = {{launch_id}}
  AND event_name IN ('PageView', 'Lead', 'Purchase')
  AND day BETWEEN {{start_date}} AND {{end_date}}
GROUP BY day, event_name
ORDER BY day ASC, event_name ASC;
```

Visualização recomendada: bar chart empilhado ou funil nativo do Metabase.

---

### 6.4 Saúde do dispatch

**Fonte:** `dispatch_health_view`

```sql
SELECT
  destination,
  status,
  COUNT(*) AS jobs,
  MAX(last_attempt_at) AS ultima_tentativa
FROM dispatch_health_view
WHERE workspace_id = {{workspace_id}}
GROUP BY destination, status
ORDER BY destination ASC, status ASC;
```

Visualização recomendada: tabela com formatação condicional — `status = 'error'` em vermelho, `status = 'ok'` em verde.

---

### 6.5 Spend diário por plataforma

**Fonte:** `ad_performance_rollup`

```sql
SELECT
  date,
  platform,
  SUM(spend_cents_normalized) / 100.0 AS spend_brl
FROM ad_performance_rollup
WHERE launch_id = {{launch_id}}
  AND date BETWEEN {{start_date}} AND {{end_date}}
GROUP BY date, platform
ORDER BY date ASC;
```

Visualização recomendada: area chart ou bar chart agrupado por `platform`.

---

## 7. Boas práticas de segurança

- **Nunca use credenciais de admin** no Metabase. O usuário `metabase_ro` deve ser o único com acesso configurado.
- **Não exponha o Metabase publicamente** sem autenticação. Se self-hosted, coloque atrás de um reverse proxy (nginx/Caddy) com HTTPS e, opcionalmente, SSO.
- **Use o Session Pooler** do Supabase (porta 5432) para conexões externas. O Transaction Pooler (porta 6543) pode causar comportamentos inesperados com conexões de longa duração.
- **Rotacione a senha** do `metabase_ro` periodicamente. Após rotação, atualize a conexão em **Admin > Databases** e re-salve.
- **Restrinja o acesso ao dashboard** via grupos e permissões do Metabase — apenas MARKETER e OPERATOR devem ver os dados de performance de campanhas.
- Não conceda permissão de `WRITE` ou `DDL` ao usuário `metabase_ro` em nenhuma circunstância.
