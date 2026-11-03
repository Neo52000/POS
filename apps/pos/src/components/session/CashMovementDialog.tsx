import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Landmark, Loader2 } from 'lucide-react';
import { CASH_MOVEMENT_KINDS, CASH_MOVEMENT_LABELS, parseEuroToCents } from '@pos/core';
import type { CashMovementKind } from '@pos/core';
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
import { CASH_MOVEMENTS_KEY } from '@/hooks/useCashMovements';
import { usePrinter } from '@/hooks/usePrinter';
import { describeApiError } from '@/lib/edge';
import { formatEurCents } from '@/lib/format';
import { cashMovementVoucher } from '@/lib/reports';
import { rpc } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { PosSession, RecordCashMovementResult } from '@/types/pos';

const DONE_LABEL: Record<CashMovementKind, string> = {
  bank_deposit: 'Remise en banque enregistrée',
  withdrawal: 'Retrait enregistré',
  cash_in: 'Apport enregistré',
};

const KIND_ICON: Record<CashMovementKind, typeof Landmark> = {
  bank_deposit: Landmark,
  withdrawal: ArrowUpFromLine,
  cash_in: ArrowDownToLine,
};

/** Motifs proposés (un clic), le texte reste libre. */
const REASON_PRESETS: Record<CashMovementKind, string[]> = {
  bank_deposit: ['Remise en banque'],
  withdrawal: ['Paiement fournisseur', 'Prélèvement gérant', 'Achat comptant'],
  cash_in: ['Complément de fond de caisse', 'Apport de monnaie'],
};

export interface CashMovementDialogProps {
  session: PosSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Saisie d'un mouvement d'espèces hors vente (0.5.0) : remise en banque, retrait, apport.
 * Écriture serveur uniquement (`pos_record_cash_movement`, idempotente : la clé est fixée à
 * l'ouverture de la fenêtre, un nouvel essai après coupure ne double rien), puis ouverture du
 * tiroir et impression du bon à joindre au bordereau.
 */
export function CashMovementDialog({ session, open, onOpenChange }: CashMovementDialogProps) {
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const { printReport, openDrawer } = usePrinter();
  const userEmail = useSessionStore((s) => s.user?.email ?? null);
  const [kind, setKind] = useState<CashMovementKind>('bank_deposit');
  const [input, setInput] = useState('');
  const [reason, setReason] = useState(REASON_PRESETS.bank_deposit[0] ?? '');
  const [reference, setReference] = useState('');
  const [pending, setPending] = useState(false);
  const clientId = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    clientId.current = crypto.randomUUID();
    setKind('bank_deposit');
    setInput('');
    setReason(REASON_PRESETS.bank_deposit[0] ?? '');
    setReference('');
  }, [open]);

  const cents = input === '' ? null : parseEuroToCents(input);
  const valid = cents !== null && cents > 0 && reason.trim().length > 0;

  const chooseKind = (k: CashMovementKind): void => {
    setKind(k);
    setReason(REASON_PRESETS[k][0] ?? '');
  };

  const submit = async (): Promise<void> => {
    if (!valid || cents === null) return;
    setPending(true);
    try {
      const r = await rpc<RecordCashMovementResult>('pos_record_cash_movement', {
        p_session_id: session.id,
        p_kind: kind,
        p_amount_cents: cents,
        p_reason: reason.trim(),
        p_reference: reference.trim() || null,
        p_client_movement_id: clientId.current,
      });
      void qc.invalidateQueries({ queryKey: [CASH_MOVEMENTS_KEY, session.id] });
      onOpenChange(false);
      toast({
        title: `${DONE_LABEL[kind]} : ${formatEurCents(cents)}`,
        variant: 'success',
      });
      void openDrawer('cash_movement');
      void printReport(cashMovementVoucher(r.movement, session, userEmail));
    } catch (e) {
      toast({
        title: 'Mouvement non enregistré',
        description: describeApiError(e),
        variant: 'danger',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-w-2xl" data-testid="cash-movement-dialog">
        <DialogHeader>
          <DialogTitle>Mouvement d’espèces</DialogTitle>
          <DialogDescription>
            Hors vente : n’entre ni dans le chiffre d’affaires ni dans la TVA, seulement dans les
            espèces attendues du tiroir. Enregistrement définitif (une erreur se corrige par un
            mouvement inverse).
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          {CASH_MOVEMENT_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <Button
                key={k}
                type="button"
                variant={kind === k ? 'default' : 'secondary'}
                size="touch"
                onClick={() => chooseKind(k)}
                data-testid={`cash-movement-kind-${k}`}
                aria-pressed={kind === k}
              >
                <Icon className="h-5 w-5" /> {CASH_MOVEMENT_LABELS[k]}
              </Button>
            );
          })}
        </div>
        <div className="grid grid-cols-[1fr_260px] gap-4">
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-border bg-bg p-3 text-center">
              <p className="text-sm text-muted">
                {kind === 'cash_in' ? 'Entrée dans le tiroir' : 'Sortie du tiroir'}
              </p>
              <p className="text-4xl font-bold tabular" data-testid="cash-movement-amount">
                {cents === null ? '—' : formatEurCents(cents)}
              </p>
            </div>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              inputMode="decimal"
              data-no-vk=""
              placeholder="0,00"
              className="text-center text-2xl"
              aria-label="Montant en euros"
              data-testid="cash-movement-amount-input"
            />
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              Motif
              <Input
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                data-testid="cash-movement-reason"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {REASON_PRESETS[kind].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={cn(
                    'rounded-full border border-border px-3 py-1 text-sm',
                    reason === p && 'border-accent text-accent',
                  )}
                  onClick={() => setReason(p)}
                >
                  {p}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              {kind === 'bank_deposit' ? 'N° de bordereau (optionnel)' : 'Référence (optionnel)'}
              <Input
                value={reference}
                maxLength={60}
                onChange={(e) => setReference(e.target.value)}
                data-testid="cash-movement-reference"
              />
            </label>
          </div>
          <NumPad
            decimal
            onDigit={(d) => setInput((p) => (d === ',' && p.includes(',') ? p : p + d))}
            onBackspace={() => setInput((p) => p.slice(0, -1))}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Annuler
          </Button>
          <Button
            size="touch"
            disabled={!valid || pending}
            onClick={() => void submit()}
            data-testid="cash-movement-submit"
          >
            {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : null} Enregistrer et imprimer
            le bon
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
