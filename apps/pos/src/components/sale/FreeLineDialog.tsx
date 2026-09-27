import { useEffect, useState } from 'react';
import { parseEuroToCents } from '@pos/core';
import { VAT_RATES_FR } from '@pos/core';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatVatRate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FreeLineInput } from '@/stores/cartStore';
import { parseQty } from '@/lib/saleInput';

export interface FreeLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: FreeLineInput) => void;
  /** EAN inconnu au catalogue : pré-remplit le libellé et rattache le code à la ligne. */
  ean?: string | null;
}

/** Article libre (sans référence) : libellé, prix TTC, taux de TVA. */
export function FreeLineDialog({ open, onOpenChange, onSubmit, ean = null }: FreeLineDialogProps) {
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [vat, setVat] = useState<string>('20.00');
  const cents = parseEuroToCents(price);
  const qtyValue = parseQty(qty);
  const valid = label.trim().length > 0 && cents !== null && cents > 0 && qtyValue !== null;

  // Formulaire vierge à chaque ouverture (une saisie annulée ne revient pas).
  useEffect(() => {
    if (!open) return;
    setLabel(ean ? `Article ${ean}` : '');
    setPrice('');
    setQty('1');
    setVat('20.00');
  }, [open, ean]);

  const submit = (): void => {
    if (!valid || cents === null || qtyValue === null) return;
    onSubmit({
      label: label.trim(),
      unit_price_ttc_cents: cents,
      vat_rate: vat,
      qty: qtyValue,
      ...(ean ? { ean } : {}),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ean ? `Article inconnu · EAN ${ean}` : 'Article libre'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Libellé
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
              placeholder="Prestation, divers…"
            />
          </label>
          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              Prix unitaire TTC (€)
              <Input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="0,00"
                data-testid="free-line-price"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              Quantité
              <Input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="decimal"
                data-testid="free-line-qty"
              />
            </label>
          </div>
          <div className="flex flex-col gap-1.5 text-sm text-muted">
            TVA
            <div className="flex flex-wrap gap-2">
              {VAT_RATES_FR.map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant={vat === r ? 'default' : 'secondary'}
                  size="touch"
                  className={cn('min-w-[72px]')}
                  onClick={() => setVat(r)}
                >
                  {formatVatRate(r)}
                </Button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="touch"
              onClick={() => onOpenChange(false)}
            >
              Annuler
            </Button>
            <Button type="submit" size="touch" disabled={!valid} data-testid="free-line-submit">
              Ajouter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
