import { supabase } from '@/lib/supabase';
import type { PosSettingsMap } from '@/types/pos';

/**
 * Réglages d'en-tête/pied de ticket (`pos_settings` : legal, ticket_footer, software), mis en cache
 * localement pour imprimer des tickets provisoires hors ligne.
 */
const CACHE_KEY = 'pos.ticket.settings.v1';
const KEYS = ['legal', 'ticket_footer', 'software'] as const;

export function cachedTicketSettings(): PosSettingsMap | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as PosSettingsMap) : null;
  } catch {
    return null;
  }
}

/** Relit `pos_settings` (en ligne) ; renvoie le cache si la lecture échoue. */
export async function refreshTicketSettings(): Promise<PosSettingsMap | null> {
  try {
    const { data, error } = await supabase.from('pos_settings').select('key, value');
    if (error || !Array.isArray(data)) return cachedTicketSettings();
    const map: PosSettingsMap = {};
    for (const row of data as Array<{ key: string; value: unknown }>) {
      if ((KEYS as readonly string[]).includes(row.key)) map[row.key] = row.value;
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    } catch {
      // stockage indisponible
    }
    return map;
  } catch {
    return cachedTicketSettings();
  }
}
