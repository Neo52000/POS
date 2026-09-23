import { supabase } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import type { PosEventType } from '@/types/pos';

/**
 * Journal des événements (JET, `pos_events`) via `pos_log_event`. Non bloquant : une erreur
 * est tracée en console mais n'interrompt jamais l'UI.
 */
export async function logEvent(
  type: PosEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { register, session } = useSessionStore.getState();
  try {
    const { error } = await supabase.rpc('pos_log_event', {
      p_event_type: type,
      p_payload: payload,
      p_client_at: new Date().toISOString(),
      p_register_id: register?.id ?? null,
      p_session_id: session?.id ?? null,
    });
    if (error) console.warn(`[events] ${type}:`, error.message);
  } catch (e) {
    console.warn(`[events] ${type}:`, e);
  }
}
