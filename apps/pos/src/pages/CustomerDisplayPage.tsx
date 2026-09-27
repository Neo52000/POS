import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { subscribeDisplay } from '@/lib/customerDisplay';
import type { DisplayMessage } from '@/lib/customerDisplay';
import { formatEurCents, formatPercent, formatQty } from '@/lib/format';
import { selectTotals, useCartStore } from '@/stores/cartStore';

/** Durée d'affichage de l'écran « Merci » avant le retour à l'accueil. */
const THANKS_MS = 8000;
/** Sans réponse de la caisse, lecture unique du panier persisté. */
const FALLBACK_MS = 1000;

type Shown = Exclude<DisplayMessage, { type: 'hello' }>;

/** État initial sans caisse joignable : panier persisté (`pos.cart.v1`) ou accueil. */
function fromPersistedCart(): Shown {
  const cart = useCartStore.getState();
  if (cart.lines.length === 0) return { type: 'idle' };
  const totals = selectTotals(cart);
  return {
    type: 'cart',
    lines: totals.lines.map((c, i) => ({
      key: cart.lines[i]?.key ?? String(i),
      label: c.label,
      qty: c.qty,
      unit_price_ttc_cents: c.unit_price_ttc_cents,
      discount_percent: c.discount_percent,
      line_ttc_cents: c.line_ttc_cents,
    })),
    total_ttc_cents: totals.total_ttc_cents,
    global_discount_percent: cart.global_discount_percent,
    customer_name: null,
  };
}

/**
 * Écran client plein écran (route `/display`, hors authentification) : accueil, panier,
 * reste à payer, remerciement avec rendu monnaie. Ne lit que ce que la caisse diffuse.
 */
export function CustomerDisplayPage() {
  const [shown, setShown] = useState<Shown>({ type: 'idle' });
  const thanksUntil = useRef(0);
  const received = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeDisplay((msg) => {
      if (msg.type === 'hello') return;
      received.current = true;
      // Le rendu monnaie reste affiché : seul un nouveau panier l'interrompt.
      if (msg.type === 'sale_completed') thanksUntil.current = Date.now() + THANKS_MS;
      else if (msg.type === 'idle' && Date.now() < thanksUntil.current) return;
      else thanksUntil.current = 0;
      setShown(msg);
    });
    const fallback = setTimeout(() => {
      if (!received.current) setShown(fromPersistedCart());
    }, FALLBACK_MS);
    return () => {
      unsubscribe();
      clearTimeout(fallback);
    };
  }, []);

  // Retour à l'accueil après le remerciement.
  useEffect(() => {
    if (shown.type !== 'sale_completed') return;
    const t = setTimeout(() => setShown({ type: 'idle' }), THANKS_MS);
    return () => clearTimeout(t);
  }, [shown]);

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-text"
      data-testid="customer-display"
      data-state={shown.type}
    >
      <header className="flex items-baseline justify-between px-10 py-6">
        <p className="text-3xl font-semibold">
          Ma Papeterie <span className="text-accent">·</span>{' '}
          <span className="text-xl font-normal text-muted">Chaumont</span>
        </p>
        {shown.type === 'cart' && shown.customer_name && (
          <p className="text-xl text-muted">{shown.customer_name}</p>
        )}
      </header>

      {shown.type === 'idle' && (
        <main className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-6xl font-bold">Bienvenue</p>
          <p className="text-2xl text-muted">Fournitures de bureau et scolaires</p>
        </main>
      )}

      {shown.type === 'cart' && (
        <main className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(360px,40%)] gap-8 px-10 pb-10">
          <ul className="min-h-0 overflow-hidden" data-testid="display-lines">
            {shown.lines.slice(-8).map((l) => (
              <li
                key={l.key}
                className="flex items-baseline justify-between gap-6 border-b border-border py-4 text-2xl"
              >
                <span className="min-w-0 flex-1 truncate">
                  {formatQty(l.qty)} × {l.label}
                </span>
                {l.discount_percent > 0 && (
                  <span className="shrink-0 text-lg text-warning">
                    −{formatPercent(l.discount_percent)}
                  </span>
                )}
                <span className="font-semibold tabular">{formatEurCents(l.line_ttc_cents)}</span>
              </li>
            ))}
            {shown.lines.length > 8 && (
              <li className="py-3 text-lg text-muted">
                + {shown.lines.length - 8} article(s) précédent(s)
              </li>
            )}
          </ul>
          <section className="flex flex-col justify-end rounded-3xl border border-border bg-surface p-8">
            {shown.global_discount_percent > 0 && (
              <p className="mb-2 text-2xl text-warning">
                Remise −{formatPercent(shown.global_discount_percent)}
              </p>
            )}
            <p className="text-2xl uppercase tracking-wide text-muted">Total TTC</p>
            <p className="text-[96px] font-bold leading-none tabular" data-testid="display-total">
              {formatEurCents(shown.total_ttc_cents)}
            </p>
          </section>
        </main>
      )}

      {shown.type === 'payment' && (
        <main className="flex flex-1 flex-col items-center justify-center gap-6">
          <p className="text-3xl text-muted">Total {formatEurCents(shown.total_ttc_cents)}</p>
          <p className="text-3xl uppercase tracking-wide text-muted">
            {shown.remaining_cents > 0 ? 'Reste à payer' : 'Réglé'}
          </p>
          <p
            className="text-[128px] font-bold leading-none tabular"
            data-testid="display-remaining"
          >
            {formatEurCents(shown.remaining_cents)}
          </p>
        </main>
      )}

      {shown.type === 'sale_completed' && (
        <main className="flex flex-1 flex-col items-center justify-center gap-6">
          <CheckCircle2 className="h-24 w-24 text-success" />
          <p className="text-6xl font-bold">Merci et à bientôt !</p>
          <p className="text-3xl text-muted">Total {formatEurCents(shown.total_ttc_cents)}</p>
          {shown.change_cents > 0 && (
            <p className="text-5xl">
              Rendu monnaie :{' '}
              <span className="font-bold text-success tabular" data-testid="display-change">
                {formatEurCents(shown.change_cents)}
              </span>
            </p>
          )}
        </main>
      )}
    </div>
  );
}
