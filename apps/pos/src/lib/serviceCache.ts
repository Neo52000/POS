import type { PosProduct } from '@/types/pos';

const KEY = 'pos.services.v1';

/** Dernière liste de prestations reçue (secours hors ligne) ; jamais bloquant. */
export function readServiceCache(): PosProduct[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as PosProduct[]) : null;
  } catch {
    return null;
  }
}

export function writeServiceCache(products: PosProduct[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(products));
  } catch {
    /* stockage indisponible : sans effet */
  }
}
