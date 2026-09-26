import { Loader2, SearchX, Star } from 'lucide-react';
import type { PosProduct } from '@/types/pos';
import { ProductTile } from './ProductTile';

export interface ProductGridProps {
  products: PosProduct[] | undefined;
  loading: boolean;
  enabled: boolean;
  error: string | null;
  onPick: (product: PosProduct) => void;
  /** Touches rapides affichées quand aucune recherche n'est en cours. */
  favorites: PosProduct[];
  onPickFavorite: (product: PosProduct) => void;
  onToggleFavorite: (product: PosProduct) => void;
}

function Tiles({
  products,
  onPick,
  favoriteIds,
  onToggleFavorite,
  testId,
}: {
  products: PosProduct[];
  onPick: (product: PosProduct) => void;
  favoriteIds: Set<string>;
  onToggleFavorite: (product: PosProduct) => void;
  testId: string;
}) {
  return (
    <div
      className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 overflow-y-auto pb-4 pr-1"
      data-testid={testId}
    >
      {products.map((p) => (
        <ProductTile
          key={p.id}
          product={p}
          onPick={onPick}
          favorite={favoriteIds.has(p.id)}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
}

export function ProductGrid({
  products,
  loading,
  enabled,
  error,
  onPick,
  favorites,
  onPickFavorite,
  onToggleFavorite,
}: ProductGridProps) {
  const favoriteIds = new Set(favorites.map((f) => f.id));
  if (!enabled) {
    if (favorites.length > 0) {
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
            <Star className="h-4 w-4" /> Favoris
          </p>
          <Tiles
            products={favorites}
            onPick={onPickFavorite}
            favoriteIds={favoriteIds}
            onToggleFavorite={onToggleFavorite}
            testId="favorites-grid"
          />
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
        <p className="text-lg">Scannez un article ou tapez au moins 2 caractères.</p>
        <p className="text-sm">
          Nom, marque ou code EAN · « 3* » avant un article pour en ajouter 3.
        </p>
        <p className="text-sm">
          Épinglez vos articles courants avec <Star className="inline h-4 w-4" /> pour les retrouver
          ici.
        </p>
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      {loading && (
        <Loader2
          className="absolute right-2 top-0 z-10 h-5 w-5 animate-spin text-muted"
          aria-label="Recherche en cours"
        />
      )}
      <Tiles
        products={products}
        onPick={onPick}
        favoriteIds={favoriteIds}
        onToggleFavorite={onToggleFavorite}
        testId="product-grid"
      />
    </div>
  );
}
