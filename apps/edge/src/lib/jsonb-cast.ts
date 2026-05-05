/**
 * jsonb-cast.ts — Helper para forçar cast `::jsonb` explícito em writes Drizzle.
 *
 * T-13-013.
 *
 * Bug: o driver `pg-cloudflare-workers` (Hyperdrive) NÃO faz cast implícito
 * de `text` → `jsonb` quando o Drizzle serializa o objeto via JSON.stringify
 * antes de enviar pro driver. Resultado: a coluna jsonb recebe uma JSON
 * string (jsonb_typeof='string') em vez de um object/array.
 *
 * Sintomas observados:
 *   • `pages.event_config` editado via UI virava string-dentro-de-jsonb,
 *     o Edge lia `ec.canonical` como undefined e `/v1/config` retornava
 *     `allowed_event_names: []` → todos eventos client-side bloqueados.
 *   • `workspaces.config` PATCH virava string, `jsonb_set` falhava com
 *     "cannot set path in scalar".
 *   • `raw_events.payload` em todo INSERT (todos adapters) também grava
 *     como string — consumers compensam com parse interno.
 *
 * Reprodução isolada: passar objeto direto pro driver `pg` standalone (Node)
 * funciona — vira jsonb-object. Mesmo objeto via Drizzle no Cloudflare Workers
 * vira jsonb-string. Logo o problema é específico da combinação Drizzle +
 * Hyperdrive driver.
 *
 * Fix recomendado: passar com cast explícito usando este helper:
 *
 *   import { jsonb } from '../lib/jsonb-cast';
 *   ...
 *   await db.update(pages)
 *     .set({ eventConfig: jsonb({ canonical: ['PageView'] }) })
 *     ...
 *
 * Equivalente ao SQL `'{"canonical":["PageView"]}'::jsonb`.
 */

import { sql, type SQL } from 'drizzle-orm';

/**
 * Wraps a JS value as a typed jsonb literal in a Drizzle SQL expression.
 *
 * Por que `sql.raw()` com dollar-quoted string em vez de bind param:
 *
 * Tentamos primeiro `sql\`${JSON.stringify(v)}::jsonb\`` (parametrizado).
 * No Postgres standalone (Node `pg`) isso vira `$1::jsonb` e o cast resolve
 * a string como jsonb-object. Mas o driver `pg-cloudflare-workers` (Hyperdrive)
 * trata o param como text-com-aspas literal — `'{"a":1}'::jsonb` resolve pra
 * jsonb-object, mas o que chega é `''{"a":1}''::jsonb` (aspas duplicadas
 * pra escape SQL), e isso vira `jsonb-string` contendo `'{"a":1}'`.
 *
 * Workaround: dollar-quoted string `$gt$<json>$gt$::jsonb`. Postgres aceita
 * strings literais delimitadas por `$tag$` sem escape — o JSON serializado
 * vai inline no SQL sem necessidade de escape de aspas. Tag `$gt$` é única o
 * suficiente pra não colidir com conteúdo JSON razoável (tag colision exigiria
 * a string `$gt$` literal dentro do JSON, que JSON.stringify nunca produz).
 *
 * Equivalente ao SQL `$gt$<json>$gt$::jsonb`.
 *
 * Segurança: JSON.stringify produz string que nunca contém `$gt$` (não é
 * sequência válida de escape JSON, e JSON.stringify quota qualquer `$`
 * literal nas strings — espera, na verdade `$` não é caractere especial em
 * JSON, então pode aparecer). Pra segurança, usamos um tag aleatório
 * suficientemente improvável: `$gtjsonb<random>$`.
 *
 * @param value Any JSON-serializable value (object, array, primitive).
 * @returns Drizzle SQL fragment safe para usar em `.set()` / `.values()`.
 */
export function jsonb(value: unknown): SQL {
  const serialized = JSON.stringify(value);
  // Dollar tag único — colisão exigiria essa exata string aparecer no JSON.
  // Se o JSON contiver `$gtjsonb$`, escolhemos tag alternativa.
  let tag = '$gtjsonb$';
  if (serialized.includes(tag)) {
    // Fallback raríssimo — gera tag aleatória.
    tag = `$gtjsonb_${Math.random().toString(36).slice(2, 10)}$`;
  }
  return sql.raw(`${tag}${serialized}${tag}::jsonb`);
}
