import { useQuery } from '@tanstack/react-query';
import { rpc } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';

const ADMIN_CACHE_KEY = 'pos.is_admin.v1';

function cachedAdmin(userId: string | undefined): boolean | undefined {
  if (!userId) return undefined;
  try {
    const raw = localStorage.getItem(ADMIN_CACHE_KEY);
    if (!raw) return undefined;
    const c = JSON.parse(raw) as { user_id: string; admin: boolean };
    return c.user_id === userId ? c.admin : undefined;
  } catch {
    return undefined;
  }
}

/** Rôle administrateur caisse (`is_pos_admin()`, `pos_user_roles.role = 'admin'`), mis en cache. */
export function useIsAdmin(): { isAdmin: boolean; isLoading: boolean } {
  const userId = useSessionStore((s) => s.user?.id);
  const query = useQuery({
    queryKey: ['is_pos_admin', userId ?? null],
    queryFn: async () => {
      const admin = (await rpc<boolean | null>('is_pos_admin')) === true;
      try {
        localStorage.setItem(ADMIN_CACHE_KEY, JSON.stringify({ user_id: userId, admin }));
      } catch {
        // stockage indisponible
      }
      return admin;
    },
    enabled: !!userId,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const fallback = cachedAdmin(userId);
  return {
    isAdmin: query.data ?? fallback ?? false,
    isLoading: query.isLoading && fallback === undefined,
  };
}
