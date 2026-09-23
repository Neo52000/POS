import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatEurCents } from '@/lib/format';
import type { PosProduct, PriceTier } from '@/types/pos';

export interface PriceTierPickerProps {
  product: PosProduct | null;
  onPick: (product: PosProduct, tier: PriceTier, cents: number) => void;
  onClose: () => void;
}

export function tierToCents(tier: PriceTier): number {
  return Math.round(Number(tier.price) * 100);
}

/** Choix manuel d'un palier de prix (`pos_price_tiers`). */
export function PriceTierPicker({ product, onPick, onClose }: PriceTierPickerProps) {
  const tiers = product?.pos_price_tiers ?? [];
  return (
    <Dialog open={product !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{product?.name}</DialogTitle>
          <DialogDescription>Choisissez le tarif à appliquer.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {tiers.map((tier, i) => (
            <Button
              key={`${tier.title}-${i}`}
              variant="secondary"
              size="touch"
              className="justify-between"
              onClick={() => product && onPick(product, tier, tierToCents(tier))}
            >
              <span>{tier.title}</span>
              <span className="font-semibold tabular">{formatEurCents(tierToCents(tier))}</span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
