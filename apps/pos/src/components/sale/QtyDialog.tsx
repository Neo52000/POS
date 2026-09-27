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
import { formatQty } from '@/lib/format';
import { parseQty } from '@/lib/saleInput';
import type { CartLine } from '@/stores/cartStore';

export interface QtyDialogProps {
  line: CartLine | null;
  onClose: () => void;
  onQty: (key: string, qty: number) => void;
}

/** Saisie directe de la quantité d'une ligne (pavé, décimales autorisées : 3 max). */
export function QtyDialog({ line, onClose, onQty }: QtyDialogProps) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (line) setValue('');
  }, [line]);
  const qty = parseQty(value);

  const apply = (): void => {
    if (!line || qty === null) return;
    onQty(line.key, qty);
    onClose();
  };

  return (
    <Dialog open={line !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Quantité · {line?.label}</DialogTitle>
          <DialogDescription>Actuelle : {line ? formatQty(line.qty) : ''}</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
          aria-label="Nouvelle quantité"
          placeholder={line ? formatQty(line.qty) : ''}
          className="text-center text-3xl"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          data-testid="qty-input"
        />
        <NumPad
          decimal
          onDigit={(d) => setValue((p) => (d === ',' && p.includes(',') ? p : p + d))}
          onBackspace={() => setValue((p) => p.slice(0, -1))}
        />
        <DialogFooter>
          <Button variant="secondary" size="touch" onClick={onClose}>
            Annuler
          </Button>
          <Button size="touch" disabled={qty === null} onClick={apply} data-testid="apply-qty">
            Valider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
