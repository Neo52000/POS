import { useState } from 'react';
import { parseEuroToCents } from '@pos/core';
import { Button } from '@/components/ui/button';
import { NumPad } from '@/components/ui/numpad';
import { formatEurCents } from '@/lib/format';

export interface CashPaymentPadProps {
  /** Reste à payer (positif) ou montant à rembourser (négatif → saisie en valeur absolue). */
  dueCents: number;
  onConfirm: (amountCents: number, changeCents: number) => void;
  onCancel: () => void;
}

const SHORTCUTS = [500, 1000, 2000, 5000];

/** Pavé espèces : montant reçu, raccourcis billets, rendu calculé. */
export function CashPaymentPad({ dueCents, onConfirm, onCancel }: CashPaymentPadProps) {
  const refund = dueCents < 0;
  const due = Math.abs(dueCents);
  const [input, setInput] = useState('');
  const typed = input === '' ? null : parseEuroToCents(input);
  const tendered = typed ?? due;
  const change = refund ? 0 : Math.max(0, tendered - due);
  const valid = tendered > 0 && (refund ? tendered === due : tendered >= due);

  const confirm = (): void => {
    if (!valid) return;
    onConfirm(refund ? -tendered : tendered, change);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="cash-pad">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-xl border border-border bg-bg px-4 py-3">
        <p className="text-sm text-muted">{refund ? 'À rembourser en espèces' : 'Montant reçu'}</p>
        <p className="text-4xl font-bold tabular" data-testid="cash-tendered">
          {formatEurCents(tendered)}
        </p>
        {!refund && (
          <p className="text-lg text-muted">
            Rendu :{' '}
            <span className="font-semibold text-success tabular" data-testid="cash-change">
              {formatEurCents(change)}
            </span>
          </p>
        )}
      </div>
      {!refund && (
        <div className="grid grid-cols-5 gap-2">
          <Button variant="secondary" size="touch" onClick={() => setInput('')}>
            Exact
          </Button>
          {SHORTCUTS.map((s) => (
            <Button
              key={s}
              variant="secondary"
              size="touch"
              onClick={() => setInput(String(s / 100))}
              data-testid={`cash-shortcut-${s}`}
            >
              {formatEurCents(s)}
            </Button>
          ))}
        </div>
      )}
      {!refund && (
        <NumPad
          decimal
          onDigit={(d) => setInput((p) => (d === ',' && p.includes(',') ? p : p + d))}
          onBackspace={() => setInput((p) => p.slice(0, -1))}
        />
      )}
      <div className="flex justify-end gap-3">
        <Button variant="secondary" size="touch" onClick={onCancel}>
          Annuler
        </Button>
        <Button size="pay" disabled={!valid} onClick={confirm} data-testid="cash-confirm">
          Valider {formatEurCents(tendered)}
        </Button>
      </div>
    </div>
  );
}
