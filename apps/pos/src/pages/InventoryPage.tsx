import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Loader2, Search, Send, Trash2, WifiOff, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumPad } from '@/components/ui/numpad';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useLiveQuery } from '@/hooks/useLiveQuery';
import { useProductSearch } from '@/hooks/useProductSearch';
import { productByEan } from '@/lib/catalog';
import { db } from '@/lib/db';
import { formatLongDate } from '@/lib/format';
import { removeInventoryLine, sendInventory, upsertInventoryLine } from '@/lib/inventory';
import type { ConfirmedInventoryLine } from '@/lib/inventory';
import { cn, errorMessage } from '@/lib/utils';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { PosProduct } from '@/types/pos';

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Inventaire (admin) : scan/recherche → quantité comptée → lot local → `pos-stock-adjust`. */
export function InventoryPage() {
  const { isAdmin, isLoading } = useIsAdmin();
  const qc = useQueryClient();
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const toast = useUiStore((s) => s.toast);
  const registerId = useSessionStore((s) => s.register?.id ?? null);
  const lines = useLiveQuery(() => db.inventory.orderBy('added_at').toArray(), [], []);
  const [query, setQuery] = useState('');
  const search = useProductSearch(query);
  const [current, setCurrent] = useState<PosProduct | null>(null);
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState(() => `Inventaire du ${formatLongDate(new Date())}`);
  const [sending, setSending] = useState(false);
  const [confirmed, setConfirmed] = useState<ConfirmedInventoryLine[]>([]);

  const select = useCallback(
    (p: PosProduct) => {
      setCurrent(p);
      setQuery('');
      const existing = lines.find((l) => l.product_id === p.id);
      setCounted(existing ? String(existing.counted) : '');
    },
    [lines],
  );

  const onScan = useCallback(
    async (code: string) => {
      try {
        const p = await productByEan(code);
        if (!p) {
          toast({ title: 'Produit inconnu', description: `EAN ${code}`, variant: 'warning' });
          return;
        }
        select(p);
      } catch (e) {
        toast({ title: 'Erreur de scan', description: errorMessage(e), variant: 'danger' });
      }
    },
    [select, toast],
  );

  useBarcodeScanner((code) => void onScan(code), isAdmin && !sending);

  const countedN = counted === '' ? null : Number(counted);
  const countedValid = countedN !== null && Number.isInteger(countedN) && countedN >= 0;

  const addLine = async (): Promise<void> => {
    if (!current || !countedValid || countedN === null) return;
    try {
      await upsertInventoryLine(current, countedN);
      toast({
        title: `${current.name} : ${countedN} compté(s)`,
        variant: 'success',
        durationMs: 2000,
      });
      setCurrent(null);
      setCounted('');
    } catch (e) {
      toast({ title: 'Ligne non ajoutée', description: errorMessage(e), variant: 'danger' });
    }
  };

  const send = async (): Promise<void> => {
    setSending(true);
    try {
      const r = await sendInventory(reason.trim(), { registerId });
      setConfirmed((prev) => [...r.confirmed, ...prev]);
      if (r.confirmed.length) void qc.invalidateQueries({ queryKey: ['products'] });
      toast({
        title: `${r.confirmed.length} ligne(s) confirmée(s)`,
        description: r.errors
          ? `${r.errors} ligne(s) en erreur${r.stoppedByNetwork ? ' (réseau)' : ''}`
          : undefined,
        variant: r.errors ? 'warning' : 'success',
      });
    } catch (e) {
      toast({ title: 'Envoi impossible', description: errorMessage(e), variant: 'danger' });
    } finally {
      setSending(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-muted"
        data-testid="inventory-forbidden"
      >
        Inventaire réservé aux administrateurs de la caisse.
      </div>
    );
  }

  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 200;

  return (
    <div className="grid h-full grid-cols-[1fr_480px]" data-testid="inventory-page">
      <section className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-6 w-6 text-accent" />
          <h2 className="text-xl font-semibold">Inventaire</h2>
          {offline && (
            <Badge variant="danger" className="ml-auto">
              <WifiOff className="mr-1 h-3.5 w-3.5" /> Hors ligne : envoi impossible
            </Badge>
          )}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Scanner un code-barres ou rechercher un produit…"
            className="pl-12"
            autoComplete="off"
            data-testid="inventory-search"
          />
        </div>
        {search.enabled && (
          <ul className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
            {search.isFetching && !search.data && (
              <li className="py-3 text-center text-muted">
                <Loader2 className="inline h-5 w-5 animate-spin" />
              </li>
            )}
            {(search.data ?? []).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => select(p)}
                  className="flex min-h-touch w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 text-left hover:border-accent"
                  data-testid="inventory-result"
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-xs text-muted">{p.ean ?? ''}</span>
                  <Badge variant="secondary">stock {p.stock_boutique}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}

        {current ? (
          <div
            className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-5"
            data-testid="inventory-current"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold">{current.name}</p>
                <p className="text-sm text-muted">
                  {current.brand ?? ''} {current.ean ? `· EAN ${current.ean}` : ''}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-touch"
                aria-label="Annuler"
                onClick={() => setCurrent(null)}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-2xl border border-border bg-bg p-3">
                <p className="text-xs uppercase text-muted">Stock actuel</p>
                <p className="text-3xl font-bold tabular" data-testid="inventory-stock">
                  {current.stock_boutique}
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-bg p-3">
                <p className="text-xs uppercase text-muted">Compté</p>
                <p className="text-3xl font-bold tabular" data-testid="inventory-counted">
                  {counted === '' ? '—' : counted}
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-bg p-3">
                <p className="text-xs uppercase text-muted">Écart</p>
                <p
                  className={cn(
                    'text-3xl font-bold tabular',
                    countedValid && countedN !== null && countedN - current.stock_boutique !== 0
                      ? 'text-warning'
                      : 'text-success',
                  )}
                >
                  {countedValid && countedN !== null
                    ? signed(countedN - current.stock_boutique)
                    : '—'}
                </p>
              </div>
            </div>
            <NumPad
              onDigit={(d) => setCounted((c) => (c.length >= 6 ? c : (c === '0' ? '' : c) + d))}
              onBackspace={() => setCounted((c) => c.slice(0, -1))}
              onClear={() => setCounted('')}
            />
            <Button
              size="pay"
              disabled={!countedValid}
              onClick={() => void addLine()}
              data-testid="inventory-add"
            >
              Ajouter au lot
            </Button>
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-border p-8 text-center text-muted">
            Scannez un article ou recherchez-le pour saisir la quantité comptée.
          </p>
        )}
      </section>

      <aside className="flex min-h-0 flex-col border-l border-border bg-surface">
        <div className="flex items-center justify-between p-4">
          <p className="text-sm uppercase tracking-wide text-muted">
            Lot en cours ({lines.length})
          </p>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-4" data-testid="inventory-lines">
          {lines.length === 0 && <li className="py-6 text-center text-muted">Lot vide</li>}
          {lines.map((l) => {
            const delta = l.counted - l.stock_seen;
            return (
              <li
                key={l.idempotency_key}
                className="flex items-center gap-3 border-b border-border py-3"
                data-testid="inventory-line"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{l.label}</p>
                  <p className="text-xs text-muted">
                    stock {l.stock_seen} → compté {l.counted}
                  </p>
                  {l.status === 'error' && l.error && (
                    <p className="text-xs text-danger">{l.error}</p>
                  )}
                </div>
                <span
                  className={cn(
                    'text-lg font-semibold tabular',
                    delta === 0 ? 'text-muted' : delta > 0 ? 'text-success' : 'text-warning',
                  )}
                >
                  {signed(delta)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-touch"
                  aria-label="Retirer la ligne"
                  onClick={() => void removeInventoryLine(l.idempotency_key)}
                  disabled={sending}
                >
                  <Trash2 className="h-5 w-5 text-danger" />
                </Button>
              </li>
            );
          })}
        </ul>
        {confirmed.length > 0 && (
          <div className="max-h-[200px] overflow-y-auto border-t border-border px-4 py-2">
            <p className="mb-1 text-xs uppercase tracking-wide text-muted">Confirmées</p>
            <ul className="flex flex-col gap-1 text-sm" data-testid="inventory-confirmed">
              {confirmed.map((c, i) => (
                <li key={`${c.product_id}-${i}`} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <span className="tabular text-muted">
                    {c.stock_before} → {c.stock_after}
                  </span>
                  <span className="tabular">{signed(c.delta)}</span>
                  {c.already_applied && <Badge variant="muted">déjà appliqué</Badge>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-3 border-t border-border p-4">
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Motif (3 à 200 caractères)
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="inventory-reason"
            />
          </label>
          <Button
            size="pay"
            className="w-full"
            disabled={lines.length === 0 || sending || offline || !reasonValid}
            title={offline ? 'Envoi impossible hors ligne' : undefined}
            onClick={() => void send()}
            data-testid="inventory-send"
          >
            {sending ? <Loader2 className="h-6 w-6 animate-spin" /> : <Send className="h-6 w-6" />}
            Envoyer ({lines.length})
          </Button>
        </div>
      </aside>
    </div>
  );
}
