import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AlertTriangle, Camera, PackagePlus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { CustomerSearchDialog } from '@/components/customer/CustomerSearchDialog';
import { QuoteImportDialog } from '@/components/customer/QuoteImportDialog';
import { PaymentSheet } from '@/components/payment/PaymentSheet';
import { CameraScannerDialog } from '@/components/sale/CameraScannerDialog';
import { CartPanel } from '@/components/sale/CartPanel';
import { FreeLineDialog } from '@/components/sale/FreeLineDialog';
import { GlobalDiscountDialog } from '@/components/sale/GlobalDiscountDialog';
import { ParkedSheet } from '@/components/sale/ParkedSheet';
import { PriceTierPicker } from '@/components/sale/PriceTierPicker';
import { ProductGrid } from '@/components/sale/ProductGrid';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { lookupProductByEan } from '@/hooks/useProductByEan';
import { PRODUCT_SEARCH_LIMIT, useProductSearch } from '@/hooks/useProductSearch';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSession } from '@/hooks/useSession';
import { beep } from '@/lib/beep';
import { searchProducts } from '@/lib/catalog';
import { logEvent, logEventNow } from '@/lib/events';
import { formatEurCents, formatQty } from '@/lib/format';
import { parseMultiplier } from '@/lib/saleInput';
import { isValidEan, normalizeScannedCode } from '@/lib/scanner';
import { describeApiError } from '@/lib/apiError';
import { errorMessage } from '@/lib/utils';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import { draftCapturedCents, useCheckoutDraftStore } from '@/stores/checkoutDraftStore';
import { useCustomerStore } from '@/stores/customerStore';
import { MAX_PARKED, useParkedStore } from '@/stores/parkedStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import type { PosProduct } from '@/types/pos';

/** Page de vente : recherche/scan à gauche, panier à droite. */
export function SalePage() {
  const [query, setQuery] = useState('');
  const [tierProduct, setTierProduct] = useState<{ product: PosProduct; qty: number } | null>(null);
  const [camera, setCamera] = useState(false);
  const [freeLine, setFreeLine] = useState(false);
  const [freeLineEan, setFreeLineEan] = useState<string | null>(null);
  const [unknownEan, setUnknownEan] = useState<string | null>(null);
  const [customerDialog, setCustomerDialog] = useState(false);
  const [quoteDialog, setQuoteDialog] = useState(false);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [cartModal, setCartModal] = useState(false);
  const [globalDialog, setGlobalDialog] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [paying, setPaying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { qty: multiplier, term } = parseMultiplier(query);
  const search = useProductSearch(term);
  const sessionQuery = useSession();
  const session = useSessionStore((s) => s.session);
  const addProduct = useCartStore((s) => s.addProduct);
  const addFreeLine = useCartStore((s) => s.addFreeLine);
  const removeLine = useCartStore((s) => s.remove);
  const setLocked = useCartStore((s) => s.setLocked);
  const lines = useCartStore((s) => s.lines);
  const globalDiscount = useCartStore((s) => s.global_discount_percent);
  const attach = useCustomerStore((s) => s.attach);
  const pricingBusy = useCustomerStore((s) => s.resolving || s.pendingLines > 0);
  const parkedCount = useParkedStore((s) => s.parked.length);
  const favorites = useSettingsStore((s) => s.favorites);
  const toggleFavorite = useSettingsStore((s) => s.toggleFavorite);
  const draft = useCheckoutDraftStore((s) => s.draft);
  const discardDraft = useCheckoutDraftStore((s) => s.discard);
  const setGlobalDiscount = useCartStore((s) => s.setGlobalDiscount);
  const maxDiscountPercent = useSettingsStore((s) => s.maxDiscountPercent);
  const { isAdmin } = useIsAdmin();
  const toast = useUiStore((s) => s.toast);
  const totals = useMemo(
    () => selectTotals({ lines, global_discount_percent: globalDiscount }),
    [lines, globalDiscount],
  );
  const capturedCents = draftCapturedCents(draft);

  const anyDialogOpen =
    tierProduct !== null ||
    camera ||
    freeLine ||
    customerDialog ||
    quoteDialog ||
    paying ||
    parkedOpen ||
    cartModal ||
    globalDialog ||
    confirmAbandon;
  const dialogOpenRef = useRef(anyDialogOpen);
  dialogOpenRef.current = anyDialogOpen;
  const queryRef = useRef(query);
  queryRef.current = query;

  // Pendant l'encaissement, le panier est figé (aucun tarif asynchrone ne change le total).
  useEffect(() => {
    setLocked(paying);
    return () => setLocked(false);
  }, [paying, setLocked]);

  const focusSearch = useCallback(() => {
    if (dialogOpenRef.current) return;
    inputRef.current?.focus();
  }, []);

  // Champ de recherche toujours focus (hors dialogues).
  useEffect(() => {
    if (!anyDialogOpen) {
      const t = setTimeout(focusSearch, 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [anyDialogOpen, focusSearch]);

  const warnStock = useCallback(
    (product: PosProduct) => {
      if (product.stock_boutique <= 0) {
        toast({
          title: 'Stock boutique à zéro',
          description: product.name,
          variant: 'warning',
          durationMs: 2500,
        });
      }
    },
    [toast],
  );

  /** Ajoute un produit ; `qty` issu du multiplicateur « n* » (consommé par l'appelant). */
  const pick = useCallback(
    (product: PosProduct, qty = 1) => {
      try {
        if (product.pos_price_tiers && product.pos_price_tiers.length > 0) {
          setTierProduct({ product, qty });
          return;
        }
        addProduct(product, { qty });
        warnStock(product);
      } catch (e) {
        beep();
        toast({ title: 'Article non ajouté', description: errorMessage(e), variant: 'danger' });
      }
    },
    [addProduct, toast, warnStock],
  );

  /** Tuile ou Entrée : applique puis efface le multiplicateur éventuel. */
  const pickFromSearch = useCallback(
    (product: PosProduct) => {
      const m = parseMultiplier(queryRef.current);
      pick(product, m.qty ?? 1);
      if (m.qty !== null) setQuery(m.term);
    },
    [pick],
  );

  const onScan = useCallback(
    async (code: string) => {
      // Une saisie en cours est conservée ; seul un multiplicateur « n* » est consommé.
      const m = parseMultiplier(queryRef.current);
      if (m.qty !== null) setQuery('');
      setUnknownEan(null);
      try {
        const product = await lookupProductByEan(code);
        if (!product) {
          beep();
          setUnknownEan(code);
          toast({ title: 'Produit inconnu', description: `EAN ${code}`, variant: 'warning' });
          return;
        }
        pick(product, m.qty ?? 1);
      } catch (e) {
        beep();
        toast({ title: 'Erreur de scan', description: errorMessage(e), variant: 'danger' });
      }
    },
    [pick, toast],
  );

  const onReject = useCallback(
    (code: string) => {
      beep();
      toast({
        title: 'Code-barres refusé',
        description: `« ${code} » n’est pas un EAN valide. Rescannez ou saisissez l’article.`,
        variant: 'warning',
      });
    },
    [toast],
  );

  useBarcodeScanner((code) => void onScan(code), !anyDialogOpen, undefined, onReject);

  const pickFavorite = useCallback(
    async (fav: PosProduct) => {
      // Le favori n'est qu'un raccourci : prix et stock sont relus au catalogue.
      try {
        const fresh = fav.ean
          ? await lookupProductByEan(fav.ean)
          : ((await searchProducts(fav.name, PRODUCT_SEARCH_LIMIT)).find((p) => p.id === fav.id) ??
            null);
        if (!fresh) {
          beep();
          toast({
            title: 'Favori introuvable au catalogue',
            description: fav.name,
            variant: 'warning',
          });
          return;
        }
        pickFromSearch(fresh);
      } catch (e) {
        toast({ title: 'Favori indisponible', description: errorMessage(e), variant: 'danger' });
      }
    },
    [pickFromSearch, toast],
  );

  const park = useCallback(() => {
    if (useCartStore.getState().lines.length === 0) return;
    if (useParkedStore.getState().park()) {
      toast({ title: 'Ticket mis en attente', variant: 'success', durationMs: 2000 });
    } else {
      toast({
        title: `Limite de ${MAX_PARKED} tickets en attente atteinte`,
        description: 'Rappelez ou supprimez un ticket en attente.',
        variant: 'warning',
      });
    }
  }, [toast]);

  const checkout = useCallback(() => {
    if (useCartStore.getState().lines.length === 0 || pricingBusy) return;
    setPaying(true);
  }, [pricingBusy]);

  const resumeDraft = (): void => {
    if (!draft) return;
    useCartStore
      .getState()
      .restore(draft.lines, draft.quote_id, draft.global_discount_percent ?? 0);
    useCustomerStore.setState({ account: draft.account, pricing: {}, error: null });
    setPaying(true);
  };

  const abandonDraft = async (): Promise<void> => {
    if (!draft) return;
    setAbandoning(true);
    try {
      const payload = { ...draft, captured_cents: capturedCents };
      // CB déjà débitée : la preuve JET doit exister avant d'effacer le brouillon.
      if (capturedCents > 0) await logEventNow('checkout_draft_abandoned', payload);
      else void logEvent('checkout_draft_abandoned', payload);
      discardDraft();
      setConfirmAbandon(false);
      if (capturedCents > 0) {
        toast({
          title: 'Encaissement abandonné',
          description: `Remboursez ${formatEurCents(capturedCents)} au client via le TPE.`,
          variant: 'warning',
          durationMs: 10_000,
        });
      }
    } catch (e) {
      toast({ title: 'Abandon impossible', description: describeApiError(e), variant: 'danger' });
    } finally {
      setAbandoning(false);
    }
  };

  // Raccourcis clavier (inactifs quand un dialogue est ouvert).
  useEffect(() => {
    if (anyDialogOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      const ctrlEnter = e.key === 'Enter' && (e.ctrlKey || e.metaKey);
      if (e.key === 'F1') inputRef.current?.focus();
      else if (e.key === 'F2') {
        setFreeLineEan(null);
        setFreeLine(true);
      } else if (e.key === 'F4') setCustomerDialog(true);
      else if (e.key === 'F6') {
        if (useCartStore.getState().lines.length > 0) setGlobalDialog(true);
      } else if (e.key === 'F8') park();
      else if (e.key === 'F9') setParkedOpen(true);
      else if (e.key === 'F12' || ctrlEnter) checkout();
      else if (e.key === 'Delete' && queryRef.current === '') {
        const last = useCartStore.getState().lines.at(-1);
        if (last) removeLine(last.key);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyDialogOpen, park, checkout, removeLine]);

  if (sessionQuery.isSuccess && !session) {
    return <Navigate to="/closing" replace />;
  }

  const searchReady =
    !!search.data && !search.isPlaceholderData && search.debouncedQuery === term.trim();

  return (
    <div className="grid h-full grid-cols-[1fr_420px]" data-testid="sale-page">
      <section className="flex min-h-0 flex-col gap-3 p-4">
        {draft && !paying && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/50 bg-warning/10 px-4 py-3"
            role="alert"
            data-testid="draft-banner"
          >
            <AlertTriangle className="h-6 w-6 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Encaissement interrompu</p>
              <p className="text-sm text-muted">
                {draft.lines.length} ligne(s) ·{' '}
                {formatEurCents(selectTotals(draft).total_ttc_cents)}
                {capturedCents > 0
                  ? ` · CB déjà débitée : ${formatEurCents(capturedCents)}`
                  : ` · ${draft.payments.length} paiement(s) saisi(s)`}
              </p>
            </div>
            <Button
              variant="secondary"
              size="touch"
              onClick={() => setConfirmAbandon(true)}
              data-testid="draft-abandon"
            >
              Abandonner
            </Button>
            <Button size="touch" onClick={resumeDraft} data-testid="draft-resume">
              Reprendre l’encaissement
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => setTimeout(focusSearch, 80)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
                if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
                // EAN tapé au clavier (trop lent pour la détection douchette).
                const code = normalizeScannedCode(term);
                if (isValidEan(code)) {
                  e.preventDefault();
                  setQuery('');
                  void onScan(code);
                  return;
                }
                // Résultats de la saisie courante uniquement (jamais ceux de la frappe précédente).
                const only = searchReady && search.data?.length === 1 ? search.data[0] : undefined;
                if (only) {
                  pick(only, multiplier ?? 1);
                  setQuery('');
                }
              }}
              placeholder="Rechercher ou scanner un article (F1)"
              className="pl-12 pr-28"
              autoFocus
              autoComplete="off"
              data-testid="product-search"
            />
            {multiplier !== null && (
              <span
                className="absolute right-16 top-1/2 -translate-y-1/2 rounded-lg bg-accent px-2 py-1 text-sm font-semibold text-white"
                data-testid="qty-multiplier"
              >
                × {formatQty(multiplier)}
              </span>
            )}
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1 top-1/2 flex h-14 w-14 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:text-text"
                aria-label="Effacer"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
          <Button
            variant="secondary"
            size="touch"
            onClick={() => setCamera(true)}
            title="Scanner avec la caméra"
          >
            <Camera className="h-5 w-5" /> Caméra
          </Button>
          <Button
            variant="secondary"
            size="touch"
            onClick={() => {
              setFreeLineEan(null);
              setFreeLine(true);
            }}
            title="Article libre (F2)"
          >
            <PackagePlus className="h-5 w-5" /> Libre
          </Button>
        </div>
        {unknownEan && (
          <div
            className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2"
            data-testid="unknown-ean"
          >
            <p className="flex-1 text-sm">
              EAN <span className="font-mono">{unknownEan}</span> inconnu du catalogue.
            </p>
            <Button
              size="touch"
              variant="secondary"
              onClick={() => {
                setFreeLineEan(unknownEan);
                setFreeLine(true);
                setUnknownEan(null);
              }}
            >
              Vendre en article libre
            </Button>
            <Button
              size="icon-touch"
              variant="ghost"
              aria-label="Ignorer"
              onClick={() => setUnknownEan(null)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        )}
        <ProductGrid
          products={search.data}
          loading={search.isFetching}
          enabled={search.enabled}
          error={search.isError ? errorMessage(search.error) : null}
          onPick={pickFromSearch}
          favorites={favorites}
          onPickFavorite={(p) => void pickFavorite(p)}
          onToggleFavorite={toggleFavorite}
        />
      </section>

      <CartPanel
        onCheckout={checkout}
        onCustomer={() => setCustomerDialog(true)}
        onQuotes={() => setQuoteDialog(true)}
        onPark={park}
        onShowParked={() => setParkedOpen(true)}
        parkedCount={parkedCount}
        pricingBusy={pricingBusy}
        onModalChange={setCartModal}
        onGlobalDiscount={() => setGlobalDialog(true)}
      />
      <GlobalDiscountDialog
        open={globalDialog}
        current={globalDiscount}
        onClose={() => setGlobalDialog(false)}
        onApply={setGlobalDiscount}
        maxPercent={maxDiscountPercent}
        isAdmin={isAdmin}
      />

      <PriceTierPicker
        product={tierProduct?.product ?? null}
        onClose={() => setTierProduct(null)}
        onPick={(product, tier, cents) => {
          try {
            addProduct(product, {
              qty: tierProduct?.qty ?? 1,
              unit_price_ttc_cents: cents,
              price_tier_title: tier.title,
              public_price_ttc_cents: cents,
            });
            warnStock(product);
          } catch (e) {
            toast({ title: 'Article non ajouté', description: errorMessage(e), variant: 'danger' });
          }
          setTierProduct(null);
        }}
      />
      <CameraScannerDialog
        open={camera}
        onOpenChange={setCamera}
        onScan={(code) => void onScan(code)}
      />
      <FreeLineDialog
        open={freeLine}
        onOpenChange={setFreeLine}
        ean={freeLineEan}
        onSubmit={(input) => {
          try {
            addFreeLine(input);
          } catch (e) {
            toast({ title: 'Article non ajouté', description: errorMessage(e), variant: 'danger' });
          }
        }}
      />
      <CustomerSearchDialog
        open={customerDialog}
        onOpenChange={setCustomerDialog}
        onPick={(c) => {
          setCustomerDialog(false);
          void attach(c);
        }}
      />
      <QuoteImportDialog open={quoteDialog} onOpenChange={setQuoteDialog} />
      <ParkedSheet open={parkedOpen} onOpenChange={setParkedOpen} currentLines={lines.length} />
      <ConfirmDialog
        open={confirmAbandon}
        title="Abandonner l’encaissement interrompu ?"
        description={
          capturedCents > 0
            ? `${formatEurCents(capturedCents)} ont déjà été débités par carte : l’abandon est tracé au journal et le client doit être remboursé via le TPE.`
            : 'Les paiements saisis sont abandonnés (tracé au journal). Le panier est conservé.'
        }
        confirmLabel="Abandonner"
        danger
        busy={abandoning}
        onCancel={() => setConfirmAbandon(false)}
        onConfirm={() => void abandonDraft()}
      />
      <PaymentSheet open={paying} onOpenChange={setPaying} totals={totals} />
    </div>
  );
}
