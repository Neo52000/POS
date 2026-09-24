import { describeApiError, isNetworkFailure } from '@/lib/apiError';
import { db } from '@/lib/db';
import type { InventoryLine } from '@/lib/db';
import { edge } from '@/lib/edge';
import { uuidv4 } from '@/lib/uuid';
import type {
  PosProduct,
  StockAdjustInput,
  StockAdjustLineResult,
  StockAdjustResult,
} from '@/types/pos';

/**
 * Lot d'inventaire (lot 6) : lignes conservées dans Dexie (`inventory`) jusqu'à confirmation
 * serveur ; clé d'idempotence générée une fois par ligne (nouvelle clé si le comptage change).
 */

export const INVENTORY_CHUNK_SIZE = 100;

export async function upsertInventoryLine(product: PosProduct, counted: number): Promise<void> {
  if (!Number.isInteger(counted) || counted < 0) throw new Error('Quantité comptée invalide');
  await db.transaction('rw', db.inventory, async () => {
    const existing = await db.inventory.where('product_id').equals(product.id).first();
    if (existing && existing.counted === counted) {
      await db.inventory.update(existing.idempotency_key, {
        stock_seen: product.stock_boutique,
        status: 'pending',
        error: null,
      });
      return;
    }
    if (existing) await db.inventory.delete(existing.idempotency_key);
    await db.inventory.add({
      idempotency_key: uuidv4(),
      product_id: product.id,
      label: product.name,
      ean: product.ean,
      stock_seen: product.stock_boutique,
      counted,
      added_at: existing?.added_at ?? new Date().toISOString(),
      status: 'pending',
      error: null,
    });
  });
}

export async function removeInventoryLine(idempotencyKey: string): Promise<void> {
  await db.inventory.delete(idempotencyKey);
}

export interface ConfirmedInventoryLine extends StockAdjustLineResult {
  label: string;
  counted: number;
}

export interface InventorySendReport {
  confirmed: ConfirmedInventoryLine[];
  errors: number;
  stoppedByNetwork: boolean;
}

/** Envoie le lot à `pos-stock-adjust` par tranches de 100 ; retire les lignes confirmées. */
export async function sendInventory(
  reason: string,
  opts: {
    registerId?: string | null;
    adjust?: (input: StockAdjustInput) => Promise<StockAdjustResult>;
  } = {},
): Promise<InventorySendReport> {
  const adjust = opts.adjust ?? ((input: StockAdjustInput) => edge.stockAdjust(input));
  const lines = await db.inventory.orderBy('added_at').toArray();
  const report: InventorySendReport = { confirmed: [], errors: 0, stoppedByNetwork: false };
  for (let i = 0; i < lines.length; i += INVENTORY_CHUNK_SIZE) {
    const chunk: InventoryLine[] = lines.slice(i, i + INVENTORY_CHUNK_SIZE);
    try {
      const res = await adjust({
        items: chunk.map((l) => ({
          product_id: l.product_id,
          counted: l.counted,
          idempotency_key: l.idempotency_key,
          label: l.label,
        })),
        reason,
        ...(opts.registerId ? { register_id: opts.registerId } : {}),
      });
      for (const line of chunk) {
        const r = res.results.find((x) => x.product_id === line.product_id);
        if (r && !r.error && (r.applied || r.already_applied)) {
          await db.inventory.delete(line.idempotency_key);
          report.confirmed.push({ ...r, label: line.label, counted: line.counted });
        } else {
          await db.inventory.update(line.idempotency_key, {
            status: 'error',
            error: r?.error ?? 'Aucun résultat serveur pour cette ligne',
          });
          report.errors += 1;
        }
      }
    } catch (e) {
      const message = describeApiError(e);
      for (const line of chunk) {
        await db.inventory.update(line.idempotency_key, { status: 'error', error: message });
      }
      report.errors += chunk.length;
      if (isNetworkFailure(e)) {
        report.stoppedByNetwork = true;
        break;
      }
    }
  }
  return report;
}
