import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NumPad } from '@/components/ui/numpad';
import { formatPercent } from '@/lib/format';
import { parsePercent } from '@/lib/saleInput';

export interface GlobalDiscountDialogProps {
  open: boolean;
  current: number;
  onClose: () => void;
  onApply: (percent: number) => void;
  /** Remise maximale (%) sans droits administrateur. */
  maxPercent: number;
  isAdmin: boolean;
}

const QUICK = [0, 5, 10, 15, 20];

/**
 * Remise globale en % : chaque ligne est vendue avec `max(remise ligne, remise globale)`.
 * Pas de remise globale en euros : elle ne peut pas être exacte ligne par ligne (SPEC §12.6).
 */
export function GlobalDiscountDialog({
  open,
  current,
  onClose,
  onApply,
  maxPercent,
  isAdmin,
}: GlobalDiscountDialogProps) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue(current ? String(current).replace('.', ',') : '');
  }, [open, current]);

  const percent = parsePercent(value);
  const overCap = percent !== null && percent > maxPercent && !isAdmin;
  const valid = percent !== null && !overCap;

  const apply = (): void => {
    if (!valid || percent === null) return;
    onApply(percent);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="global-discount-dialog">
        <DialogHeader>
          <DialogTitle>Remise globale</DialogTitle>
          <DialogDescription>
            Appliquée à toutes les lignes ; une remise de ligne plus forte est conservée (pas de
            cumul).
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {QUICK.map((q) => (
            <Button
              key={q}
              variant={value === String(q) ? 'default' : 'secondary'}
              size="touch"
              className="min-w-[64px]"
              disabled={q > maxPercent && !isAdmin}
              onClick={() => setValue(String(q))}
            >
              {q} %
            </Button>
          ))}
        </div>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
          aria-label="Remise globale en pourcentage"
          placeholder="0"
          className="text-center text-2xl"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          data-testid="global-discount-input"
        />
        <NumPad
          decimal
          onDigit={(d) => setValue((p) => (d === ',' && p.includes(',') ? p : p + d))}
          onBackspace={() => setValue((p) => p.slice(0, -1))}
        />
        {overCap && (
          <p className="text-sm text-warning" role="alert" data-testid="global-discount-cap">
            Au-delà de {formatPercent(maxPercent)} : réservé à un administrateur.
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" size="touch" onClick={onClose}>
            Annuler
          </Button>
          <Button
            size="touch"
            disabled={!valid}
            onClick={apply}
            data-testid="apply-global-discount"
          >
            Appliquer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
