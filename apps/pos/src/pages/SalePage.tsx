import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Camera, PackagePlus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CustomerSearchDialog } from '@/components/customer/CustomerSearchDialog';
import { QuoteImportDialog } from '@/components/customer/QuoteImportDialog';
import { PaymentSheet } from '@/components/payment/PaymentSheet';
import { CameraScannerDialog } from '@/components/sale/CameraScannerDialog';
import { CartPanel } from '@/components/sale/CartPanel';
import { FreeLineDialog } from '@/components/sale/FreeLineDialog';
import { PriceTierPicker } from '@/components/sale/PriceTierPicker';
import { ProductGrid } from '@/components/sale/ProductGrid';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { lookupProductByEan } from '@/hooks/useProductByEan';
import { useProductSearch } from '@/hooks/useProductSearch';
import { useSession } from '@/hooks/useSession';
import { errorMessage } from '@/lib/utils';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { PosProduct } from '@/types/pos';

/** Page de vente : recherche/scan à gauche, panier à droite. */
export function SalePage() {
  const [query, setQuery] = useState('');
  const [tierProduct, setTierProduct] = useState<PosProduct | null>(null);
  const [camera, setCamera] = useState(false);
  const [freeLine, setFreeLine] = useState(false);
  const [customerDialog, setCustomerDialog] = useState(false);
  const [quoteDialog, setQuoteDialog] = useState(false);
  const [paying, setPaying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useProductSearch(query);
  const sessionQuery = useSession();
  const session = useSessionStore((s) => s.session);
  const addProduct = useCartStore((s) => s.addProduct);
  const addFreeLine = useCartStore((s) => s.addFreeLine);
  const lines = useCartStore((s) => s.lines);
  const attach = useCustomerStore((s) => s.attach);
  const toast = useUiStore((s) => s.toast);
  const totals = useMemo(() => selectTotals({ lines }), [lines]);

  const anyDialogOpen =
    tierProduct !== null || camera || freeLine || customerDialog || quoteDialog || paying;

  const focusSearch = useCallback(() => {
    if (anyDialogOpen) return;
    inputRef.current?.focus();
  }, [anyDialogOpen]);

  // Champ de recherche toujours focus (hors dialogues).
  useEffect(() => {
    if (!anyDialogOpen) {
      const t = setTimeout(focusSearch, 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [anyDialogOpen, focusSearch]);

  const pick = useCallback(
    (product: PosProduct) => {
      if (product.pos_price_tiers && product.pos_price_tiers.length > 0) {
        setTierProduct(product);
        return;
      }
      addProduct(product);
      if (product.stock_boutique <= 0) {
        toast({
          title: 'Stock boutique à zéro',
          description: product.name,
          variant: 'warning',
          durationMs: 2500,
        });
      }
    },
    [addProduct, toast],
  );

  const onScan = useCallback(
    async (code: string) => {
      setQuery('');
      try {
        const product = await lookupProductByEan(code);
        if (!product) {
          toast({ title: 'Produit inconnu', description: `EAN ${code}`, variant: 'warning' });
          return;
        }
        pick(product);
      } catch (e) {
        toast({ title: 'Erreur de scan', description: errorMessage(e), variant: 'danger' });
      }
    },
    [pick, toast],
  );

  useBarcodeScanner((code) => void onScan(code), !paying);

  if (sessionQuery.isSuccess && !session) {
    return <Navigate to="/closing" replace />;
  }

  return (
    <div className="grid h-full grid-cols-[1fr_420px]" data-testid="sale-page">
      <section className="flex min-h-0 flex-col gap-3 p-4">
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
                if (
                  e.key === 'Enter' &&
                  search.data &&
                  search.data.length === 1 &&
                  search.data[0]
                ) {
                  pick(search.data[0]);
                  setQuery('');
                }
              }}
              placeholder="Rechercher un produit, scanner un code-barres…"
              className="pl-12 pr-12"
              autoFocus
              autoComplete="off"
              data-testid="product-search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:text-text"
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
            onClick={() => setFreeLine(true)}
            title="Article libre"
          >
            <PackagePlus className="h-5 w-5" /> Libre
          </Button>
        </div>
        <ProductGrid
          products={search.data}
          loading={search.isFetching}
          enabled={search.enabled}
          error={search.isError ? errorMessage(search.error) : null}
          onPick={pick}
        />
      </section>

      <CartPanel
        onCheckout={() => setPaying(true)}
        onCustomer={() => setCustomerDialog(true)}
        onQuotes={() => setQuoteDialog(true)}
      />

      <PriceTierPicker
        product={tierProduct}
        onClose={() => setTierProduct(null)}
        onPick={(product, tier, cents) => {
          addProduct(product, {
            unit_price_ttc_cents: cents,
            price_tier_title: tier.title,
            public_price_ttc_cents: cents,
          });
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
        onSubmit={(input) => addFreeLine(input)}
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
      <PaymentSheet open={paying} onOpenChange={setPaying} totals={totals} />
    </div>
  );
}
