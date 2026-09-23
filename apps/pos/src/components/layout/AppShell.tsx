import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Archive, History, Lock, Settings, ShoppingCart, Vault } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ReceiptFallbackDialog } from '@/components/ticket/ReceiptFallbackDialog';
import { useBridgeHealth } from '@/hooks/useBridgeHealth';
import { usePrinter } from '@/hooks/usePrinter';
import { useSession } from '@/hooks/useSession';
import { hasPin } from '@/lib/pin';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { StatusBar } from './StatusBar';

const NAV = [
  { to: '/', label: 'Vente', icon: ShoppingCart, end: true },
  { to: '/history', label: 'Historique', icon: History },
  { to: '/closing', label: 'Caisse', icon: Archive },
  { to: '/settings', label: 'Réglages', icon: Settings },
] as const;

function DrawerButton() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { openDrawer } = usePrinter();
  const toast = useUiStore((s) => s.toast);

  const confirm = async (): Promise<void> => {
    const ok = await openDrawer(reason.trim() || 'Ouverture manuelle');
    if (ok) toast({ title: 'Tiroir ouvert', variant: 'success' });
    setOpen(false);
    setReason('');
  };

  return (
    <>
      <Button variant="ghost" size="touch" onClick={() => setOpen(true)} title="Ouvrir le tiroir">
        <Vault className="h-5 w-5" /> Tiroir
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ouvrir le tiroir-caisse</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-2 text-sm text-muted">
            Motif (journalisé)
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Rendu monnaie, dépôt…"
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button variant="secondary" size="touch" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button size="touch" onClick={() => void confirm()}>
              Ouvrir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Coque de l'application : navigation, sondes (pont, réseau), verrouillage auto, barre de statut. */
export function AppShell() {
  const navigate = useNavigate();
  const lock = useSessionStore((s) => s.lock);
  const user = useSessionStore((s) => s.user);
  const setOnline = useUiStore((s) => s.setOnline);
  const autoLockMinutes = useSettingsStore((s) => s.autoLockMinutes);
  useBridgeHealth(true);
  useSession();

  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [setOnline]);

  const doLock = useCallback(() => {
    if (!hasPin()) return;
    lock();
    navigate('/lock');
  }, [lock, navigate]);

  // Verrouillage automatique après inactivité (plan A13) si un PIN est défini.
  useEffect(() => {
    if (!autoLockMinutes || autoLockMinutes <= 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(doLock, autoLockMinutes * 60_000);
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
    for (const ev of events) window.addEventListener(ev, arm, { passive: true });
    arm();
    return () => {
      if (timer) clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, arm);
    };
  }, [autoLockMinutes, doLock]);

  return (
    <div className="touch-ui flex h-full flex-col bg-bg text-text">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <span className="mr-3 text-base font-semibold tracking-tight">
          Ma Papeterie <span className="text-accent">POS</span>
        </span>
        <nav className="flex items-center gap-1" aria-label="Navigation principale">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => (
            <NavLink
              key={to}
              to={to}
              end={'end' in rest ? rest.end : false}
              className={({ isActive }) =>
                cn(
                  'flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted hover:bg-border/60 hover:text-text',
                )
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-2 hidden text-xs text-muted md:inline">{user?.email}</span>
          <DrawerButton />
          <Button
            variant="ghost"
            size="touch"
            onClick={doLock}
            title="Verrouiller (PIN)"
            disabled={!hasPin()}
          >
            <Lock className="h-5 w-5" /> Verrouiller
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <StatusBar />
      <ReceiptFallbackDialog />
    </div>
  );
}
