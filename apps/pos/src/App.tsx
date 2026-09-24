import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { Toaster } from '@/components/ui/toaster';
import { startOfflineRuntime } from '@/lib/offlineRuntime';
import { queryClient } from '@/lib/queryClient';
import { supabase } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import { ClosingPage } from '@/pages/ClosingPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { InventoryPage } from '@/pages/InventoryPage';
import { LockPage } from '@/pages/LockPage';
import { LoginPage } from '@/pages/LoginPage';
import { OfflinePage } from '@/pages/OfflinePage';
import { SalePage } from '@/pages/SalePage';
import { SettingsPage } from '@/pages/SettingsPage';

/** Synchronise l'état d'authentification Supabase → `sessionStore`. */
function useAuthSync(): void {
  const setUser = useSessionStore((s) => s.setUser);
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const u = data.session?.user;
      setUser(u ? { id: u.id, email: u.email ?? '' } : null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      setUser(u ? { id: u.id, email: u.email ?? '' } : null);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [setUser]);
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center text-muted" role="status">
      Chargement…
    </div>
  );
}

function RequireAuth() {
  const status = useSessionStore((s) => s.authStatus);
  const locked = useSessionStore((s) => s.locked);
  const location = useLocation();
  // Connectivité, file hors ligne, synchro catalogue : actifs tant qu'un vendeur est connecté
  // (y compris écran verrouillé).
  useEffect(() => (status === 'signed_in' ? startOfflineRuntime() : undefined), [status]);
  if (status === 'loading') return <Splash />;
  if (status === 'signed_out')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (locked && location.pathname !== '/lock') return <Navigate to="/lock" replace />;
  return <Outlet />;
}

function RedirectIfAuth() {
  const status = useSessionStore((s) => s.authStatus);
  if (status === 'loading') return <Splash />;
  if (status === 'signed_in') return <Navigate to="/" replace />;
  return <Outlet />;
}

function Router() {
  useAuthSync();
  return (
    <Routes>
      <Route element={<RedirectIfAuth />}>
        <Route path="/login" element={<LoginPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="/lock" element={<LockPage />} />
        <Route element={<AppShell />}>
          <Route index element={<SalePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/closing" element={<ClosingPage />} />
          <Route path="/offline" element={<OfflinePage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Router />
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
