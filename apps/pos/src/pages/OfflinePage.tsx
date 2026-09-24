import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Download,
  Loader2,
  Printer,
  RefreshCw,
  RotateCcw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLiveQuery } from '@/hooks/useLiveQuery';
import { useOfflineQueue, useQueuedEvents, useQueueItems } from '@/hooks/useOfflineQueue';
import { usePrinter } from '@/hooks/usePrinter';
import { probeNow } from '@/lib/connectivity';
import type { QueueStatus, QueuedCheckout } from '@/lib/db';
import { formatDateTime, formatElapsed, formatEurCents } from '@/lib/format';
import { catalogStatus, syncCatalog } from '@/lib/offlineCatalog';
import { exportQueueJson, getCachedClientSettings, replayQueue } from '@/lib/offlineQueue';
import type { ReplayReport } from '@/lib/offlineQueue';
import { cn, errorMessage } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';

const STATUS_BADGE: Record<
  QueueStatus,
  { label: string; variant: 'warning' | 'danger' | 'success' | 'default' }
> = {
  pending: { label: 'En attente', variant: 'warning' },
  replaying: { label: 'Rejeu…', variant: 'default' },
  failed: { label: 'Échec', variant: 'danger' },
  done: { label: 'Synchronisée', variant: 'success' },
};

function reportText(r: ReplayReport): string {
  const parts = [`${r.done} synchronisée(s)`];
  if (r.failed) parts.push(`${r.failed} en échec`);
  if (r.stopped === 'network') parts.push('arrêt : réseau indisponible');
  if (r.stopped === 'session_not_open') parts.push('arrêt : aucune session ouverte');
  if (r.stopped === 'unauthorized') parts.push('arrêt : reconnexion nécessaire');
  return parts.join(' · ');
}

/** File hors ligne : ventes en attente/en échec, rejeu, export, synchro catalogue, limites. */
export function OfflinePage() {
  const connectivity = useUiStore((s) => s.connectivity);
  const offlineSince = useUiStore((s) => s.offlineSince);
  const replayBlock = useUiStore((s) => s.replayBlock);
  const toast = useUiStore((s) => s.toast);
  const { stats, limits, limitState } = useOfflineQueue();
  const items = useQueueItems();
  const events = useQueuedEvents();
  const catalog = useLiveQuery(catalogStatus, [], null);
  const clientSettings = useLiveQuery(getCachedClientSettings, [], null);
  const { print } = usePrinter();
  const [busy, setBusy] = useState<string | null>(null);

  const open = items.filter((i) => i.status !== 'done');
  const done = items
    .filter((i) => i.status === 'done')
    .sort((a, b) => String(b.done_at ?? '').localeCompare(String(a.done_at ?? '')))
    .slice(0, 20);
  const pendingEvents = events.filter((e) => e.status === 'pending').length;
  const failedEvents = events.filter((e) => e.status === 'failed').length;

  const replay = async (retry?: string): Promise<void> => {
    setBusy(retry ?? 'replay');
    try {
      const reachable = await probeNow();
      if (!reachable) {
        toast({
          title: 'Toujours hors ligne',
          description: 'Serveur injoignable.',
          variant: 'warning',
        });
        return;
      }
      const r = await replayQueue(retry ? { retry } : {});
      if (r.stopped === 'busy') {
        toast({ title: 'Synchronisation déjà en cours' });
        return;
      }
      toast({
        title: 'Rejeu terminé',
        description: reportText(r),
        variant: r.failed || r.stopped ? 'warning' : 'success',
      });
    } catch (e) {
      toast({ title: 'Rejeu impossible', description: errorMessage(e), variant: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const exportJson = async (): Promise<void> => {
    setBusy('export');
    try {
      const json = await exportQueueJson();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pos-file-hors-ligne-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async (): Promise<void> => {
    setBusy('sync');
    try {
      const r = await syncCatalog();
      toast({
        title: r.error ? 'Synchronisation catalogue en échec' : 'Catalogue synchronisé',
        description:
          r.error ??
          `${r.mode === 'full' ? 'Complète' : 'Delta'} : ${r.upserted} mis à jour, ${r.deleted} retiré(s)`,
        variant: r.error ? 'danger' : 'success',
      });
    } finally {
      setBusy(null);
    }
  };

  const reprint = (item: QueuedCheckout): void => {
    if (item.provisional_ticket) void print({ ...item.provisional_ticket, duplicate: true });
  };

  return (
    <div className="grid h-full grid-cols-[1fr_400px] overflow-hidden" data-testid="offline-page">
      <section className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-xl font-semibold">File hors ligne</h2>
          <Button
            size="touch"
            onClick={() => void replay()}
            disabled={busy !== null || (stats.pending === 0 && stats.failed === 0)}
            data-testid="replay-now"
          >
            {busy === 'replay' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <RefreshCw className="h-5 w-5" />
            )}
            Rejouer maintenant
          </Button>
          <Button
            variant="secondary"
            size="touch"
            onClick={() => void exportJson()}
            disabled={busy !== null}
            data-testid="export-queue"
          >
            <Download className="h-5 w-5" /> Exporter (JSON)
          </Button>
        </div>

        {replayBlock === 'session_not_open' && (
          <p
            className="flex items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
            data-testid="replay-blocked"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Session à ouvrir : aucune session de caisse ouverte côté serveur. Les ventes restent en
            file et seront rattachées à la prochaine session ouverte.
            <Link to="/closing" className="ml-auto underline">
              Ouvrir la caisse
            </Link>
          </p>
        )}
        {replayBlock === 'unauthorized' && (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            Session utilisateur expirée : reconnectez-vous pour synchroniser la file.
          </p>
        )}

        <div className="rounded-2xl border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead>
                <TableHead>Heure de vente</TableHead>
                <TableHead className="text-right">TTC</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Erreur</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {open.map((item) => {
                const badge = STATUS_BADGE[item.status];
                return (
                  <TableRow
                    key={item.client_txn_id}
                    className="h-14"
                    data-testid="queue-item"
                    data-status={item.status}
                  >
                    <TableCell className="font-medium tabular">
                      {item.provisional_ref ??
                        (item.payload.kind === 'refund' ? 'Remboursement CB' : '—')}
                    </TableCell>
                    <TableCell>{formatDateTime(item.business_at)}</TableCell>
                    <TableCell className="text-right font-semibold tabular">
                      {formatEurCents(item.payload.totals.total_ttc_cents)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {item.attempts > 0 && (
                        <span className="ml-2 text-xs text-muted">
                          {item.attempts} essai{item.attempts > 1 ? 's' : ''}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[260px] text-xs text-danger">
                      {item.last_error_code ? `${item.last_error_code} · ` : ''}
                      {item.last_error ?? ''}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {item.provisional_ticket && (
                          <Button
                            variant="ghost"
                            size="icon-touch"
                            aria-label="Réimprimer le ticket provisoire"
                            onClick={() => reprint(item)}
                          >
                            <Printer className="h-5 w-5" />
                          </Button>
                        )}
                        {item.status === 'failed' && (
                          <Button
                            variant="secondary"
                            size="touch"
                            onClick={() => void replay(item.client_txn_id)}
                            disabled={busy !== null}
                            data-testid="queue-item-replay"
                          >
                            <RotateCcw className="h-5 w-5" /> Rejouer
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {open.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-muted"
                    data-testid="queue-empty"
                  >
                    Aucune vente en attente.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {done.length > 0 && (
          <div className="rounded-2xl border border-border bg-surface p-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-muted">
              Récemment synchronisées
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {done.map((item) => (
                <li
                  key={item.client_txn_id}
                  className="flex items-center gap-3"
                  data-testid="queue-item-done"
                >
                  <span className="tabular text-muted">{item.provisional_ref ?? '—'}</span>
                  <span>→</span>
                  <span className="font-medium tabular">{item.server_ticket_code}</span>
                  <span className="ml-auto tabular">
                    {formatEurCents(item.payload.totals.total_ttc_cents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-4">
        <div className="flex items-center gap-3">
          {connectivity === 'offline' ? (
            <WifiOff className="h-6 w-6 text-danger" />
          ) : (
            <Wifi className="h-6 w-6 text-success" />
          )}
          <div>
            <p className="font-semibold">
              {connectivity === 'offline'
                ? 'Hors ligne'
                : connectivity === 'replaying'
                  ? 'Synchronisation…'
                  : 'En ligne'}
            </p>
            {offlineSince && (
              <p className="text-sm text-muted">
                depuis {formatDateTime(offlineSince)} ({formatElapsed(offlineSince)})
              </p>
            )}
          </div>
        </div>
        <Separator />

        <div className="flex flex-col gap-1.5 text-sm" data-testid="offline-limits">
          <p className="text-xs uppercase tracking-wide text-muted">Limites hors ligne</p>
          <p>
            Ventes en attente :{' '}
            <span className="font-semibold tabular">
              {stats.pending} / {limits.offline_max_txns}
            </span>
          </p>
          <p>
            Plus ancienne :{' '}
            {stats.oldestBusinessAt ? (
              <span className="font-semibold">
                {formatElapsed(stats.oldestBusinessAt)} (max {limits.offline_max_hours} h)
              </span>
            ) : (
              '—'
            )}
          </p>
          <p>
            En échec : <span className="font-semibold tabular">{stats.failed}</span>
          </p>
          {limitState.blocked && (
            <p
              className="rounded-xl bg-danger/10 px-3 py-2 text-danger"
              data-testid="offline-blocked"
            >
              Ventes hors ligne bloquées : {limitState.message}
            </p>
          )}
          {clientSettings && (
            <p className="text-xs text-muted">
              Réglages serveur lus le {formatDateTime(clientSettings.fetched_at)}
              {Math.abs(clientSettings.clock_skew_ms) > 60_000
                ? ` · écart d’horloge ${Math.round(clientSettings.clock_skew_ms / 1000)} s`
                : ''}
            </p>
          )}
          <p className="text-xs text-muted">
            Événements JET en attente : {pendingEvents}
            {failedEvents ? ` · en échec : ${failedEvents}` : ''}
          </p>
        </div>
        <Separator />

        <div className="flex flex-col gap-1.5 text-sm" data-testid="catalog-status">
          <p className="text-xs uppercase tracking-wide text-muted">Catalogue local</p>
          <p>
            Produits :{' '}
            <span className="font-semibold tabular" data-testid="catalog-count">
              {catalog?.count ?? 0}
            </span>
          </p>
          <p>
            Dernière synchro complète :{' '}
            {catalog?.last_full_at ? formatDateTime(catalog.last_full_at) : 'jamais'}
          </p>
          <p>
            Dernière synchro delta :{' '}
            {catalog?.last_delta_at ? formatDateTime(catalog.last_delta_at) : 'jamais'}
          </p>
          {catalog?.last_error && (
            <p className={cn('text-danger')}>Dernière erreur : {catalog.last_error}</p>
          )}
          <Button
            variant="secondary"
            size="touch"
            className="mt-2"
            onClick={() => void syncNow()}
            disabled={busy !== null || connectivity === 'offline'}
            data-testid="catalog-sync"
          >
            {busy === 'sync' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <RefreshCw className="h-5 w-5" />
            )}
            Synchroniser
          </Button>
        </div>
      </aside>
    </div>
  );
}
