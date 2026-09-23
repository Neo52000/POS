import { Loader2, SearchX } from 'lucide-react';
import type { PosProduct } from '@/types/pos';
import { ProductTile } from './ProductTile';

export interface ProductGridProps {
  products: PosProduct[] | undefined;
  loading: boolean;
  enabled: boolean;
  error: string | null;
  onPick: (product: PosProduct) => void;
}

export function ProductGrid({ products, loading, enabled, error, onPick }: ProductGridProps) {
  if (!enabled) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
        <p className="text-lg">Scannez un article ou tapez au moins 2 caractères.</p>
        <p className="text-sm">Nom, marque ou code EAN.</p>
      </div>
    );
  }
  if (error) {
    return <div className="flex flex-1 items-center justify-center text-danger">{error}</div>;
  }
  if (loading && !products) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!products || products.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
        <SearchX className="h-8 w-8" />
        <p>Aucun produit trouvé.</p>
      </div>
    );
  }
  return (
    <div
      className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 overflow-y-auto pb-4 pr-1"
      data-testid="product-grid"
    >
      {products.map((p) => (
        <ProductTile key={p.id} product={p} onPick={onPick} />
      ))}
    </div>
  );
}
