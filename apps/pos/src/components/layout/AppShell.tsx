import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  MonitorSmartphone,
  Archive,
  ClipboardList,
  FileBarChart,
  GraduationCap,
  History,
  Lock,
  Maximize,
  Minimize,
  Settings,
  ShoppingCart,
  Vault,
  WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCustomerDisplayPublisher } from '@/hooks/useCustomerDisplayPublisher';
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
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { usePrinter } from '@/hooks/usePrinter';
import { useSession } from '@/hooks/useSession';
import { hasPin } from '@/lib/pin';
import { stopTraining } from '@/lib/training';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTrainingStore } from '@/stores/trainingStore';
import { useUiStore } from '@/stores/uiStore';
import { StatusBar } from './StatusBar';

interface NavItem {
  to: string;
  label: string;
  icon: typeof ShoppingCart;
  end?: boolean;
  adminOnly?: boolean;
  badge?: 'offline';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Vente', icon: ShoppingCart, end: true },
  { to: '/history', label: 'Historique', icon: History },
  { to: '/closing', label: 'Caisse', icon: Archive },
  { to: '/reports', label: 'Rapports', icon: FileBarChart },
  { to: '/offline', label: 'Hors ligne', icon: WifiOff, badge: 'offline' },
  { to: '/inventory', label: 'Inventaire', icon: ClipboardList, adminOnly: true },
  { to: '/settings', label: 'Réglages', icon: Settings },
];

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
      <Button
        variant="ghost"
        size="touch"
        onClick={() => setOpen(true)}
        title="Ouvrir le tiroir"
        aria-label="Tiroir"
      >
        <Vault className="h-5 w-5" /> <span className="hidden 2xl:inline">Tiroir</span>
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

/** Plein écran (kiosque) : masque la barre du navigateur et du système. */
function FullscreenButton() {
  const [full, setFull] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  );
  useEffect(() => {
    const onChange = (): void => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  if (typeof document === 'undefined' || !document.fullscreenEnabled) return null;
  return (
    <Button
      variant="ghost"
      size="touch"
      onClick={() =>
        void (document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen({ navigationUI: 'hide' }))
      }
      title={full ? 'Quitter le plein écran' : 'Plein écran'}
      aria-label={full ? 'Quitter le plein écran' : 'Plein écran'}
      data-testid="fullscreen"
    >
      {full ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
    </Button>
  );
}

/** Bandeau permanent du mode formation (aucune vente enregistrée). */
function TrainingBanner() {
  const tickets = useTrainingStore((s) => s.tickets.length);
  const toast = useUiStore((s) => s.toast);
  const quit = (): void => {
    stopTraining();
    toast({ title: 'Mode formation terminé', description: 'Retour à la caisse réelle.' });
  };
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-3 bg-[repeating-linear-gradient(135deg,rgb(var(--c-warning))_0_14px,rgb(var(--c-warning)/0.8)_14px_28px)] px-4 text-sm font-semibold text-bg"
      role="status"
      data-testid="training-banner"
    >
      <GraduationCap className="h-5 w-5" />
      MODE FORMATION — aucune vente n’est enregistrée · TPE simulé · {tickets} ticket(s) de
      formation
      <button
        type="button"
        onClick={quit}
        className="ml-auto rounded-lg bg-bg/90 px-3 py-1 text-text"
        data-testid="training-exit"
      >
        Quitter la formation
      </button>
    </div>
  );
}

/** Coque de l'application : navigation, sondes (pont, réseau), verrouillage auto, barre de statut. */
export function AppShell() {
  const navigate = useNavigate();
  const lock = useSessionStore((s) => s.lock);
  const user = useSessionStore((s) => s.user);
  const autoLockMinutes = useSettingsStore((s) => s.autoLockMinutes);
  const touchMode = useSettingsStore((s) => s.touchMode);
  const training = useTrainingStore((s) => s.active);
  const { isAdmin } = useIsAdmin();
  const { unsynced, stats } = useOfflineQueue();
  useBridgeHealth(true);
  useSession();
  useCustomerDisplayPublisher();

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
      {training && <TrainingBanner />}
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <span className="mr-2 whitespace-nowrap text-base font-semibold leading-tight tracking-tight">
          <span className="hidden xl:inline">Ma Papeterie </span>
          <span className="text-accent">POS</span>
        </span>
        {/* Barre d'onglets de terminal : icône + libellé empilés, 7 entrées dès 1024 px. */}
        <nav className="flex min-w-0 items-center gap-1" aria-label="Navigation principale">
          {NAV.filter((n) => !n.adminOnly || isAdmin).map(
            ({ to, label, icon: Icon, end, badge }) => (
              <NavLink
                key={to}
                to={to}
                end={end ?? false}
                className={({ isActive }) =>
                  cn(
                    'relative flex h-14 min-w-[4.5rem] flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-xs font-medium transition-colors 2xl:min-w-[5.5rem] 2xl:text-sm',
                    isActive
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted hover:bg-border/60 hover:text-text',
                  )
                }
              >
                <Icon className="h-5 w-5" />
                <span className="whitespace-nowrap">{label}</span>
                {badge === 'offline' && unsynced > 0 && (
                  <span
                    className={cn(
                      'absolute right-1 top-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                      stats.failed > 0 ? 'bg-danger text-on-accent' : 'bg-warning text-bg',
                    )}
                    data-testid="nav-offline-badge"
                  >
                    {unsynced}
                  </span>
                )}
              </NavLink>
            ),
          )}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-2 hidden max-w-40 truncate text-xs text-muted 2xl:inline">
            {user?.email}
          </span>
          <Button
            variant="ghost"
            size="touch"
            onClick={() => window.open('/display', 'pos-customer-display', 'popup')}
            title="Ouvrir l’écran client (à placer sur le second écran, F11)"
            aria-label="Écran client"
            data-testid="open-customer-display"
          >
            <MonitorSmartphone className="h-5 w-5" />
            <span className="hidden 2xl:inline">Écran client</span>
          </Button>
          {touchMode && <FullscreenButton />}
          <DrawerButton />
          <Button
            variant="ghost"
            size="touch"
            onClick={doLock}
            title="Verrouiller (PIN)"
            aria-label="Verrouiller"
            disabled={!hasPin()}
          >
            <Lock className="h-5 w-5" /> <span className="hidden 2xl:inline">Verrouiller</span>
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
