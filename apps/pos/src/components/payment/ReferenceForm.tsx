import { useState } from 'react';
import { PAYMENT_METHOD_LABELS, parseEuroToCents } from '@pos/core';
import type { PaymentMethod } from '@pos/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatEurCents } from '@/lib/format';

export interface ReferenceFormProps {
  method: Extract<PaymentMethod, 'cheque' | 'gift_ucia' | 'transfer'>;
  /** Montant par défaut = reste à payer (peut être négatif pour un remboursement). */
  dueCents: number;
  onConfirm: (amountCents: number, reference: string) => void;
  onCancel: () => void;
}

const PLACEHOLDERS: Record<ReferenceFormProps['method'], string> = {
  cheque: 'N° de chèque / banque',
  gift_ucia: 'N° du bon cadeau UCIA',
  transfer: 'Référence du virement',
};

/** Chèque / Bon cadeau UCIA / Virement : référence obligatoire + montant (défaut : reste à payer). */
export function ReferenceForm({ method, dueCents, onConfirm, onCancel }: ReferenceFormProps) {
  const refund = dueCents < 0;
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState((Math.abs(dueCents) / 100).toFixed(2).replace('.', ','));
  const cents = parseEuroToCents(amount);
  const valid = reference.trim().length > 0 && cents !== null && cents > 0;

  const submit = (): void => {
    if (!valid || cents === null) return;
    onConfirm(refund ? -cents : cents, reference.trim());
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid={`reference-form-${method}`}
    >
      <p className="text-lg font-medium">{PAYMENT_METHOD_LABELS[method]}</p>
      <label className="flex flex-col gap-1.5 text-sm text-muted">
        Référence (obligatoire)
        <Input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder={PLACEHOLDERS[method]}
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-muted">
        Montant {refund ? 'remboursé' : ''} (€)
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" size="touch" onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" size="pay" disabled={!valid}>
          Valider {cents !== null ? formatEurCents(cents) : ''}
        </Button>
      </div>
    </form>
  );
}
