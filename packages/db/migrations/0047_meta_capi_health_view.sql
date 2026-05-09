-- 0047_meta_capi_health_view.sql
-- View de saúde do Meta CAPI: para cada Purchase event, mostra quais sinais
-- de match (fbc/fbp/em/ph/ip/ua/external_id/geo) estavam presentes E projeta
-- o que efetivamente foi enviado pra Meta (incluindo enrichment via lead +
-- historical lookup).
--
-- Uso típico:
--   SELECT * FROM v_meta_capi_health
--    WHERE workspace_id = '74860330-...'
--      AND received_at > now() - interval '7 days'
--    ORDER BY received_at DESC;
--
-- Score 0..8 de match signals — 8 = todos presentes (advanced match top).
-- Sem coluna de PII em claro: todos os sinais são booleans IS NOT NULL.

CREATE OR REPLACE VIEW v_meta_capi_health AS
WITH ud_parsed AS (
  -- T-13-013: rows pré-deploy ed9a490d têm user_data como jsonb-string;
  -- (#>> '{}')::jsonb re-parseia para object idempotentemente.
  SELECT
    e.id,
    e.workspace_id,
    e.event_id,
    e.event_name,
    e.event_source,
    e.lead_id,
    e.received_at,
    (e.user_data #>> '{}')::jsonb         AS ud,
    (e.attribution #>> '{}')::jsonb       AS attr,
    (e.custom_data #>> '{}')::jsonb       AS cd,
    e.visitor_id
  FROM events e
  WHERE e.event_name IN ('Purchase', 'Lead', 'InitiateCheckout', 'Contact', 'CompleteRegistration')
),
historical AS (
  -- Para cada event, computa se há prior event do mesmo lead com fbc/fbp/ip/ua.
  -- Usado para ver se o enrichment do dispatcher consegue suprir gaps.
  SELECT
    p.id,
    EXISTS(
      SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id
         AND e2.lead_id = p.lead_id
         AND e2.received_at < p.received_at
         AND ((e2.user_data #>> '{}')::jsonb->>'fbc') IS NOT NULL
    ) AS hist_fbc,
    EXISTS(
      SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id
         AND e2.lead_id = p.lead_id
         AND e2.received_at < p.received_at
         AND ((e2.user_data #>> '{}')::jsonb->>'fbp') IS NOT NULL
    ) AS hist_fbp,
    EXISTS(
      SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id
         AND e2.lead_id = p.lead_id
         AND e2.received_at < p.received_at
         AND ((e2.user_data #>> '{}')::jsonb->>'client_ip_address') IS NOT NULL
    ) AS hist_ip,
    EXISTS(
      SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id
         AND e2.lead_id = p.lead_id
         AND e2.received_at < p.received_at
         AND ((e2.user_data #>> '{}')::jsonb->>'client_user_agent') IS NOT NULL
    ) AS hist_ua
  FROM ud_parsed p
  WHERE p.lead_id IS NOT NULL
)
SELECT
  p.id                            AS event_id,
  p.workspace_id,
  p.event_name,
  p.event_source,
  p.received_at,
  p.lead_id,
  -- Sinais NO PRÓPRIO EVENTO (events.user_data) ----------------
  (p.ud->>'fbc')                  IS NOT NULL  AS ev_fbc,
  (p.ud->>'fbp')                  IS NOT NULL  AS ev_fbp,
  (p.ud->>'client_ip_address')    IS NOT NULL  AS ev_ip,
  (p.ud->>'client_user_agent')    IS NOT NULL  AS ev_ua,
  (p.ud->>'geo_city')             IS NOT NULL  AS ev_geo,
  -- Sinais que vêm do LEAD via dispatcher --------------------
  (l.email_hash_external)         IS NOT NULL  AS lead_em,
  (l.phone_hash_external)         IS NOT NULL  AS lead_ph,
  (l.fn_hash)                     IS NOT NULL  AS lead_fn,
  (l.ln_hash)                     IS NOT NULL  AS lead_ln,
  -- Visitor ID (Meta external_id alternativo) -----------------
  (p.visitor_id)                  IS NOT NULL  AS has_external_id,
  -- Disponibilidade via HISTÓRICO (lookup deveria preencher) -
  COALESCE(h.hist_fbc, false)     AS hist_fbc,
  COALESCE(h.hist_fbp, false)     AS hist_fbp,
  COALESCE(h.hist_ip, false)      AS hist_ip,
  COALESCE(h.hist_ua, false)      AS hist_ua,
  -- Effective: o que o dispatcher VAI enviar (evento OU histórico) --
  ((p.ud->>'fbc') IS NOT NULL OR COALESCE(h.hist_fbc, false))  AS eff_fbc,
  ((p.ud->>'fbp') IS NOT NULL OR COALESCE(h.hist_fbp, false))  AS eff_fbp,
  ((p.ud->>'client_ip_address') IS NOT NULL OR COALESCE(h.hist_ip, false))  AS eff_ip,
  ((p.ud->>'client_user_agent') IS NOT NULL OR COALESCE(h.hist_ua, false))  AS eff_ua,
  -- Score de match 0..8 (eff signals + lead em/ph + geo + external_id) -----
  (
    CASE WHEN (p.ud->>'fbc') IS NOT NULL OR COALESCE(h.hist_fbc, false) THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'fbp') IS NOT NULL OR COALESCE(h.hist_fbp, false) THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'client_ip_address') IS NOT NULL OR COALESCE(h.hist_ip, false) THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'client_user_agent') IS NOT NULL OR COALESCE(h.hist_ua, false) THEN 1 ELSE 0 END +
    CASE WHEN l.email_hash_external IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN l.phone_hash_external IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'geo_city') IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN p.visitor_id IS NOT NULL THEN 1 ELSE 0 END
  ) AS match_score,
  -- Attribution (origem do evento)
  p.attr->>'utm_source'           AS utm_source,
  p.attr->>'utm_campaign'         AS utm_campaign,
  (p.attr->>'fbclid' IS NOT NULL) AS has_fbclid,
  -- Custom data
  p.cd->>'amount'                 AS amount,
  p.cd->>'currency'               AS currency
FROM ud_parsed p
LEFT JOIN historical h ON h.id = p.id
LEFT JOIN leads l ON l.id = p.lead_id;

COMMENT ON VIEW v_meta_capi_health IS
'Saúde do Meta CAPI por evento: presença de fbc/fbp/em/ph/ip/ua/geo/external_id no evento e via lookup histórico. Score 0..8 = advanced match quality projetado.';
