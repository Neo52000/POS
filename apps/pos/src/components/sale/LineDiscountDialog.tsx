import { useEffect, useState } from 'react';
import { parseEuroToCents } from '@pos/core';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatEurCents, formatPercent } from '@/lib/format';
import type { CartLine } from '@/stores/cartStore';
import { impliedDiscountPercent, parsePercent } from '@/lib/saleInput';

export interface LineDiscountDialogProps {
  line: CartLine | null;
  onClose: () => void;
  onDiscount: (key: string, percent: number) => void;
  onUnitPrice: (key: string, cents: number) => void;
  /** Remise maximale (%) autorisée sans droits administrateur. */
  maxPercent: number;
  isAdmin: boolean;
}

const QUICK = [0, 5, 10, 15, 20, 30, 50];

/** Remise en % sur une ligne (raccourcis + pavé) ou prix unitaire forcé. */
export function LineDiscountDialog({
  line,
  onClose,
  onDiscount,
  onUnitPrice,
  maxPercent,
  isAdmin,
}: LineDiscountDialogProps) {
  const [percent, setPercent] = useState('');
  const [price, setPrice] = useState('');

  useEffect(() => {
    if (line) {
      setPercent(line.discount_percent ? String(line.discount_percent).replace('.', ',') : '');
      setPrice((line.unit_price_ttc_cents / 100).toFixed(2).replace('.', ','));
    }
  }, [line]);

  const percentValue = parsePercent(percent);
  const percentOverCap = percentValue !== null && percentValue > maxPercent && !isAdmin;
  const percentValid = percentValue !== null && !percentOverCap;
  const parsedPrice = parseEuroToCents(price);
  const priceCents = parsedPrice !== null && parsedPrice >= 0 ? parsedPrice : null;
  const referenceCents = line ? (line.public_price_ttc_cents ?? line.unit_price_ttc_cents) : 0;
  const priceDiscount =
    priceCents === null ? 0 : impliedDiscountPercent(referenceCents, priceCents);
  const priceOverCap = priceDiscount > maxPercent && !isAdmin;
  const priceValid = priceCents !== null && !priceOverCap;
  const capMessage = `Au-delà de ${formatPercent(maxPercent)} : réservé à un administrateur.`;

  const applyPercent = (): void => {
    if (!line || !percentValid || percentValue === null) return;
    onDiscount(line.key, percentValue);
    onClose();
  };

  const applyPrice = (): void => {
    if (!line || !priceValid || priceCents === null) return;
    onUnitPrice(line.key, priceCents);
    onClose();
  };

  return (
    <Dialog open={line !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remise · {line?.label}</DialogTitle>
          <DialogDescription>
            Prix unitaire actuel {line ? formatEurCents(line.unit_price_ttc_cents) : ''}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="percent">
          <TabsList className="w-full">
            <TabsTrigger value="percent" className="flex-1">
              Remise %
            </TabsTrigger>
            <TabsTrigger value="price" className="flex-1">
              Prix unitaire
            </TabsTrigger>
          </TabsList>
          <TabsContent value="percent" className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {QUICK.map((q) => (
                <Button
                  key={q}
                  variant={percent === String(q) ? 'default' : 'secondary'}
                  size="touch"
                  className="min-w-[64px]"
                  disabled={q > maxPercent && !isAdmin}
                  onClick={() => setPercent(String(q))}
                >
                  {q} %
                </Button>
              ))}
            </div>
            <Input
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              inputMode="decimal"
              aria-label="Remise en pourcentage"
              placeholder="0"
              className="text-center text-2xl"
              onKeyDown={(e) => e.key === 'Enter' && applyPercent()}
            />
            <NumPad
              decimal
              onDigit={(d) => setPercent((p) => (d === ',' && p.includes(',') ? p : p + d))}
              onBackspace={() => setPercent((p) => p.slice(0, -1))}
            />
            {percentOverCap && (
              <p className="text-sm text-warning" role="alert" data-testid="discount-cap">
                {capMessage}
              </p>
            )}
            <DialogFooter>
              <Button variant="secondary" size="touch" onClick={onClose}>
                Annuler
              </Button>
              <Button
                size="touch"
                disabled={!percentValid}
                onClick={applyPercent}
                data-testid="apply-discount"
              >
                Appliquer la remise
              </Button>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="price" className="flex flex-col gap-3">
            <Input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              aria-label="Prix unitaire TTC"
              className="text-center text-2xl"
              onKeyDown={(e) => e.key === 'Enter' && applyPrice()}
            />
            <NumPad
              decimal
              onDigit={(d) => setPrice((p) => (d === ',' && p.includes(',') ? p : p + d))}
              onBackspace={() => setPrice((p) => p.slice(0, -1))}
            />
            {priceDiscount > 0 && (
              <p
                className={priceOverCap ? 'text-sm text-warning' : 'text-sm text-muted'}
                role={priceOverCap ? 'alert' : undefined}
              >
                Soit −{formatPercent(priceDiscount)} sur {formatEurCents(referenceCents)}.
                {priceOverCap ? ` ${capMessage}` : ''}
              </p>
            )}
            <DialogFooter>
              <Button variant="secondary" size="touch" onClick={onClose}>
                Annuler
              </Button>
              <Button
                size="touch"
                disabled={!priceValid}
                onClick={applyPrice}
                data-testid="apply-price"
              >
                Forcer le prix
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
