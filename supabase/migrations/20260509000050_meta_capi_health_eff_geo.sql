-- ============================================================
-- 0050_meta_capi_health_eff_geo.sql
--
-- GEO-CITY-ENRICHMENT-GAP (2026-05-09): atualiza v_meta_capi_health
-- para refletir enriquecimento de geo histórico no dispatcher Meta CAPI.
--
-- Antes desta migration:
--   - match_score contava `ev_geo` (geo no próprio evento) — não capturava
--     o enrichment via lookupHistoricalBrowserSignals.
--   - Purchase Guru sem contact.address ficava travado em score 7/8.
--
-- Depois:
--   - View ganha hist_geo_city/region/postal/country (CTE historical).
--   - View ganha eff_geo_city/region/postal/country (ev OU hist).
--   - match_score usa `eff_geo` em vez de `ev_geo` — agora atinge 8/8
--     quando o lead já passou pela LP em algum momento (tracker.js
--     captura geo via Cloudflare CF-IPCity headers).
--
-- Idempotência: DROP + CREATE (CREATE OR REPLACE não permite reordenar
-- colunas — Postgres "cannot change name of view column" error). Safe pra
-- re-run pois `IF EXISTS` evita falha quando view não existe.
-- ============================================================

DROP VIEW IF EXISTS v_meta_capi_health;

CREATE VIEW v_meta_capi_health AS
WITH ud_parsed AS (
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
  SELECT
    p.id,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'fbc') IS NOT NULL) AS hist_fbc,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'fbp') IS NOT NULL) AS hist_fbp,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'client_ip_address') IS NOT NULL) AS hist_ip,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'client_user_agent') IS NOT NULL) AS hist_ua,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND e2.visitor_id IS NOT NULL) AS hist_vid,
    -- GEO-CITY-ENRICHMENT-GAP: novo lookup geo histórico
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'geo_city') IS NOT NULL) AS hist_geo_city,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'geo_region_code') IS NOT NULL) AS hist_geo_region,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'geo_postal_code') IS NOT NULL) AS hist_geo_postal,
    EXISTS(SELECT 1 FROM events e2
       WHERE e2.workspace_id = p.workspace_id AND e2.lead_id = p.lead_id
         AND ((e2.user_data #>> '{}')::jsonb->>'geo_country') IS NOT NULL) AS hist_geo_country
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
  -- Sinais NO PRÓPRIO EVENTO --------------------------------
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
  -- External ID via tracker visitor_id -----------------------
  (p.visitor_id)                  IS NOT NULL  AS ev_external_id,
  -- Disponibilidade via HISTÓRICO ----------------------------
  COALESCE(h.hist_fbc, false)         AS hist_fbc,
  COALESCE(h.hist_fbp, false)         AS hist_fbp,
  COALESCE(h.hist_ip, false)          AS hist_ip,
  COALESCE(h.hist_ua, false)          AS hist_ua,
  COALESCE(h.hist_vid, false)         AS hist_vid,
  COALESCE(h.hist_geo_city, false)    AS hist_geo_city,
  COALESCE(h.hist_geo_region, false)  AS hist_geo_region,
  COALESCE(h.hist_geo_postal, false)  AS hist_geo_postal,
  COALESCE(h.hist_geo_country, false) AS hist_geo_country,
  -- Effective: o que o dispatcher VAI enviar (evento OU histórico) --
  ((p.ud->>'fbc') IS NOT NULL OR COALESCE(h.hist_fbc, false))                AS eff_fbc,
  ((p.ud->>'fbp') IS NOT NULL OR COALESCE(h.hist_fbp, false))                AS eff_fbp,
  ((p.ud->>'client_ip_address') IS NOT NULL OR COALESCE(h.hist_ip, false))   AS eff_ip,
  ((p.ud->>'client_user_agent') IS NOT NULL OR COALESCE(h.hist_ua, false))   AS eff_ua,
  (p.visitor_id IS NOT NULL OR COALESCE(h.hist_vid, false))                  AS eff_external_id,
  ((p.ud->>'geo_city') IS NOT NULL OR COALESCE(h.hist_geo_city, false))      AS eff_geo,
  -- Score de match 0..8 (eff signals) — agora considera eff_geo --------
  (
    CASE WHEN (p.ud->>'fbc') IS NOT NULL OR COALESCE(h.hist_fbc, false) THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'fbp') IS NOT NULL OR COALESCE(h.hist_fbp, false) THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'client_ip_address') IS NOT NULL OR COALESCE(h.hist_ip, false) THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'client_user_agent') IS NOT NULL OR COALESCE(h.hist_ua, false) THEN 1 ELSE 0 END +
    CASE WHEN l.email_hash_external IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN l.phone_hash_external IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN (p.ud->>'geo_city') IS NOT NULL OR COALESCE(h.hist_geo_city, false) THEN 1 ELSE 0 END +
    CASE WHEN p.visitor_id IS NOT NULL OR COALESCE(h.hist_vid, false) THEN 1 ELSE 0 END
  ) AS match_score,
  -- Attribution (origem do evento) ---------------------------
  p.attr->>'utm_source'           AS utm_source,
  p.attr->>'utm_campaign'         AS utm_campaign,
  (p.attr->>'fbclid' IS NOT NULL) AS has_fbclid,
  -- Custom data
  p.cd->>'amount'                 AS amount,
  p.cd->>'currency'               AS currency,
  p.cd->>'product_name'           AS product_name
FROM ud_parsed p
LEFT JOIN historical h ON h.id = p.id
LEFT JOIN leads l ON l.id = p.lead_id;

COMMENT ON VIEW v_meta_capi_health IS
'Saúde do Meta CAPI por evento: presença de fbc/fbp/em/ph/ip/ua/geo/external_id no evento e via lookup histórico (sem filtro temporal — ADR-039). Score 0..8 = advanced match quality projetado. eff_geo: GEO-CITY-ENRICHMENT-GAP fix (2026-05-09).';
