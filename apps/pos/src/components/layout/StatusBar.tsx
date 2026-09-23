import { useEffect, useState } from 'react';
import { CreditCard, Printer, Wifi, WifiOff } from 'lucide-react';
import { env } from '@/lib/env';
import { formatElapsed } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';

function Dot({ state }: { state: 'ok' | 'ko' | 'unknown' }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full',
        state === 'ok' && 'bg-success',
        state === 'ko' && 'bg-danger',
        state === 'unknown' && 'bg-muted',
      )}
    />
  );
}

/** Barre de statut : session, réseau, pont TPE, imprimante, version. */
export function StatusBar() {
  const session = useSessionStore((s) => s.session);
  const register = useSessionStore((s) => s.register);
  const online = useUiStore((s) => s.online);
  const bridgeStatus = useUiStore((s) => s.bridgeStatus);
  const tpe = useUiStore((s) => s.tpeReachable);
  const printer = useUiStore((s) => s.printerReachable);
  const simulate = useUiStore((s) => s.bridgeSimulate);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const tpeState =
    bridgeStatus === 'ok' ? (tpe ? 'ok' : 'ko') : bridgeStatus === 'ko' ? 'ko' : 'unknown';
  const printerState =
    bridgeStatus === 'ok' ? (printer ? 'ok' : 'ko') : bridgeStatus === 'ko' ? 'ko' : 'unknown';

  return (
    <footer
      className="flex h-9 shrink-0 items-center gap-5 border-t border-border bg-surface px-4 text-xs text-muted"
      data-testid="status-bar"
    >
      <span className="font-medium text-text">{register?.code ?? 'Caisse ?'}</span>
      {session ? (
        <span>
          Session n°{session.session_number} · ouverte depuis{' '}
          {formatElapsed(session.opened_at, now)}
        </span>
      ) : (
        <span className="text-warning">Aucune session ouverte</span>
      )}
      <span className="flex items-center gap-1.5">
        {online ? (
          <Wifi className="h-3.5 w-3.5 text-success" />
        ) : (
          <WifiOff className="h-3.5 w-3.5 text-danger" />
        )}
        {online ? 'En ligne' : 'Hors ligne'}
      </span>
      <span className="flex items-center gap-1.5" title="Pont TPE">
        <Dot state={bridgeStatus} /> Pont{' '}
        {bridgeStatus === 'ok' ? 'OK' : bridgeStatus === 'ko' ? 'KO' : '…'}
        {simulate && <span className="text-warning">(simulé)</span>}
      </span>
      <span className="flex items-center gap-1.5" title="TPE">
        <CreditCard className="h-3.5 w-3.5" /> <Dot state={tpeState} /> TPE
      </span>
      <span className="flex items-center gap-1.5" title="Imprimante">
        <Printer className="h-3.5 w-3.5" /> <Dot state={printerState} /> Imprimante
      </span>
      <span className="ml-auto">Ma Papeterie POS v{env.appVersion}</span>
    </footer>
  );
}
