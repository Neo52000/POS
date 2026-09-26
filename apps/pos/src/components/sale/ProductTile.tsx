import { ImageOff, Layers, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatEurCents } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PosProduct } from '@/types/pos';

export interface ProductTileProps {
  product: PosProduct;
  onPick: (product: PosProduct) => void;
  favorite?: boolean;
  onToggleFavorite?: (product: PosProduct) => void;
}

/** Tuile produit tactile (≥ 120 px) : image, nom, marque, prix TTC, badge stock. */
export function ProductTile({ product, onPick, favorite, onToggleFavorite }: ProductTileProps) {
  const hasTiers = Array.isArray(product.pos_price_tiers) && product.pos_price_tiers.length > 0;
  const stockOut = product.stock_boutique <= 0;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onPick(product)}
        data-testid="product-tile"
        className={cn(
          'flex h-full min-h-[150px] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.98]',
        )}
      >
        <div className="relative flex h-[84px] w-full items-center justify-center bg-bg">
          {product.image_url ? (
            <img
              src={product.image_url}
              alt=""
              className="h-full w-full object-contain p-1"
              loading="lazy"
            />
          ) : (
            <ImageOff className="h-7 w-7 text-border" />
          )}
          {hasTiers && (
            <Badge variant="secondary" className="absolute left-2 top-2 gap-1">
              <Layers className="h-3 w-3" /> Paliers
            </Badge>
          )}
          {stockOut && (
            <Badge variant="warning" className="absolute right-2 top-2">
              Stock {product.stock_boutique}
            </Badge>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-0.5 p-2.5">
          <span className="line-clamp-2 text-sm font-medium leading-tight">{product.name}</span>
          <span className="text-xs text-muted">{product.brand ?? ' '}</span>
          <span className="mt-auto pt-1 text-base font-semibold tabular">
            {hasTiers ? 'Prix au choix' : formatEurCents(product.price_ttc_cents)}
          </span>
        </div>
      </button>
      {onToggleFavorite && (
        <button
          type="button"
          onClick={() => onToggleFavorite(product)}
          className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          aria-pressed={!!favorite}
          data-testid="toggle-favorite"
        >
          <Star className={cn('h-5 w-5', favorite && 'fill-warning text-warning')} />
        </button>
      )}
    </div>
  );
}
