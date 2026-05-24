-- ============================================================
-- 0057_recovery_template_url_param_fix.sql
--
-- FIX: o url_button_param do template de recovery era '?off=Fn4XA0'
-- (contém '?' e '='). O WhatsApp trata o {{1}} do botão como SUFIXO
-- DINÂMICO e percent-encoda caracteres reservados → a URL chegava como
--   https://pay.onprofit.com.br/fvOsQjDO%3Foff%3DFn4XA0   (quebrada)
-- em vez de
--   https://pay.onprofit.com.br/fvOsQjDO?off=Fn4XA0
--
-- Correção (Opção B): o template foi reeditado na Unnichat para
--   URL do botão = 'https://pay.onprofit.com.br/fvOsQjDO?off={{1}}'
-- ou seja, o '?off=' passou para a parte ESTÁTICA e o {{1}} agora é só
-- 'Fn4XA0' (alfanumérico, sem encoding). Este UPDATE alinha o nosso
-- url_button_params ao novo template.
--
-- Sem redeploy: o recovery-sender lê recovery_templates.url_button_params
-- em tempo de query.
--
-- Aplicação: USER APLICA VIA PSQL — APÓS o template ser re-aprovado na
-- Meta. Antes disso a campanha deve seguir pausada (active=false).
-- Idempotente (UPDATE filtrado; re-run = mesmo resultado).
-- ============================================================

UPDATE recovery_templates
   SET url_button_params = '[{"type":"text","fallback":"Fn4XA0"}]'::jsonb
 WHERE workspace_id = '74860330-a528-4951-bf49-90f0b5c72521'
   AND name = 'abandono_7min_wcs_jun26';

-- Down (rollback para o valor antigo, caso necessário):
-- UPDATE recovery_templates
--    SET url_button_params = '[{"type":"text","fallback":"?off=Fn4XA0"}]'::jsonb
--  WHERE workspace_id = '74860330-a528-4951-bf49-90f0b5c72521'
--    AND name = 'abandono_7min_wcs_jun26';
