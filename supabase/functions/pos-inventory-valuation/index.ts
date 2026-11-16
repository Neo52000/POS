// =============================================================================
// pos-inventory-valuation — données de la valorisation d'inventaire pour le comptable.
// Admin POS uniquement (requirePosAdmin). Renvoie, sans calcul :
//   * le lot compté en cours (pos_inventory_lines, projet Pos) ;
//   * les références au stock boutique non nul (+ celles du lot) avec prix d'achat HT
//     (RPC ma-papeterie pos_inventory_valuation_base, service role : le prix d'achat n'est
//     jamais exposé à la clé anon).
// La PWA fusionne (compté / stock système), valorise et produit le CSV et l'A4 : apps/pos
// src/lib/inventoryReport.ts. Hors périmètre fiscal ; aucune écriture.
// =============================================================================
import { z } from 'npm:zod@3';
import { requirePosAdmin } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';

const Schema = z.object({
  /** Date de l'inventaire (jour calendaire), imprimée sur le document. */
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** `2026-11-16` valide et pas plus d'un jour dans le futur (décalage fuseau). */
function validAsOf(value: string): boolean {
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return false;
  return d.getTime() <= Date.now() + 36 * 3600 * 1000 && value >= '2000-01-01';
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    if (req.method !== 'POST') throw new ApiError('VALIDATION', 'POST attendu');
    const auth = await requirePosAdmin(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success || !validAsOf(parsed.data.as_of)) {
      throw new ApiError('VALIDATION', 'Date d’inventaire invalide');
    }

    const { data: lot, error: lotError } = await auth.db
      .from('pos_inventory_lines')
      .select('product_id, label, ean, counted, stock_seen, updated_at')
      .eq('deleted', false);
    if (lotError) throw new ApiError('DB_ERROR', `pos_inventory_lines: ${lotError.message}`);
    const counted = lot ?? [];

    const { data: products, error } = await mapapClient().rpc('pos_inventory_valuation_base', {
      p_product_ids: counted.map((l) => l.product_id),
    });
    if (error) throw new ApiError('DB_ERROR', `pos_inventory_valuation_base: ${error.message}`);

    return json(200, {
      as_of: parsed.data.as_of,
      generated_at: new Date().toISOString(),
      counted,
      products: products ?? [],
    });
  } catch (e) {
    return errorResponse(e);
  }
});
