// =============================================================================
// pos-stock-adjust — inventaire boutique (lot 6) : fixe products.stock_boutique (ma-papeterie)
// au stock compté, article par article, via la RPC service role `pos_set_stock_boutique`
// (idempotente par idempotency_key, tracée dans pos_stock_movements, reason `inventory`).
// Admin POS (is_pos_admin) ou service role. Le stock n'est pas une donnée fiscale ; le lot est
// néanmoins tracé dans le JET (`stock_adjustment`) de la caisse.
// =============================================================================
import { z } from 'npm:zod@3';
import { requirePosAdmin } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { setStockBoutique } from '../_shared/mapapeterie.ts';

/** Appels ma-papeterie par paquet (concurrence bornée), paquets traités l'un après l'autre. */
const CHUNK_SIZE = 10;

const ItemSchema = z.object({
  product_id: z.string().uuid(),
  counted: z.number().int().nonnegative(),
  idempotency_key: z.string().min(8).max(80),
  label: z.string().max(200).optional(),
});

const Schema = z.object({
  items: z.array(ItemSchema).min(1).max(200),
  reason: z.string().trim().min(3).max(200),
  register_id: z.string().uuid().optional(),
});

interface ItemResult {
  product_id: string;
  applied: boolean;
  already_applied: boolean;
  stock_before: number | null;
  stock_after: number | null;
  delta: number;
  error?: string;
}

function errorMessage(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : 'ERREUR_INCONNUE';
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    if (req.method !== 'POST') throw new ApiError('VALIDATION', 'POST attendu');
    const auth = await requirePosAdmin(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    }
    const { items, reason, register_id } = parsed.data;

    const keys = new Set<string>();
    for (const item of items) {
      if (keys.has(item.idempotency_key)) {
        throw new ApiError('VALIDATION', 'idempotency_key en double', {
          key: item.idempotency_key,
        });
      }
      keys.add(item.idempotency_key);
    }

    const results: ItemResult[] = [];
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const settled = await Promise.all(
        chunk.map(async (item): Promise<ItemResult> => {
          try {
            const r = await setStockBoutique(
              item.product_id,
              item.counted,
              reason,
              item.idempotency_key,
            );
            return {
              product_id: item.product_id,
              applied: r.applied === true,
              already_applied: r.already_applied === true,
              stock_before: r.stock_before ?? null,
              stock_after: r.stock_after ?? null,
              delta: Number(r.delta ?? 0),
            };
          } catch (e) {
            // Erreur par article (PRODUCT_NOT_FOUND, VALIDATION, réseau) : les autres continuent.
            return {
              product_id: item.product_id,
              applied: false,
              already_applied: false,
              stock_before: null,
              stock_after: null,
              delta: 0,
              error: errorMessage(e),
            };
          }
        }),
      );
      results.push(...settled);
    }

    // JET : un événement par lot, avec le JWT de l'admin (auth.uid() = auteur) ou le service role.
    const applied = results.filter((r) => r.applied);
    const { data: eventId, error: logError } = await (auth.userDb ?? auth.db).rpc('pos_log_event', {
      p_event_type: 'stock_adjustment',
      p_payload: {
        items: items.length,
        applied: applied.length,
        already_applied: results.filter((r) => r.already_applied).length,
        errors: results.filter((r) => r.error).length,
        delta_sum: applied.reduce((sum, r) => sum + r.delta, 0),
        reason,
      },
      p_client_at: null,
      p_register_id: register_id ?? null,
      p_session_id: null,
    });
    // Le stock est déjà appliqué (idempotent) : un échec de journalisation est remonté pour que
    // l'opérateur relance le même lot (mêmes clés → already_applied, nouvel événement JET).
    if (logError) throw logError;

    return json(200, { results, event_id: eventId ?? null });
  } catch (e) {
    return errorResponse(e);
  }
});
