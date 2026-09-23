import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTpePayment } from '@/hooks/useTpePayment';
import type { TpePhase } from '@/hooks/useTpePayment';
import type { BridgePaymentResult } from '@/lib/bridge';
import { logEvent } from '@/lib/events';
import { formatEurCents } from '@/lib/format';

export interface CbPaymentOutcome {
  amount_cents: number;
  manual_fallback: boolean;
  tpe_response: unknown;
}

export interface CbPaymentDialogProps {
  open: boolean;
  /** Montant signé : positif = débit, négatif = crédit (remboursement). */
  amountCents: number;
  onOpenChange: (open: boolean) => void;
  onApproved: (outcome: CbPaymentOutcome) => void;
}

const PHASE_LABEL: Record<TpePhase, string> = {
  idle: 'Prêt',
  connecting: 'Connexion au TPE…',
  sent: 'Montant envoyé au TPE',
  waiting: 'En attente de la carte…',
  done: 'Terminé',
};

const STATUS_LABEL: Record<BridgePaymentResult['status'], string> = {
  approved: 'Paiement accepté',
  declined: 'Paiement refusé',
  timeout: 'Délai dépassé (TPE sans réponse)',
  error: 'Erreur de communication',
  busy: 'Un paiement est déjà en cours sur le TPE',
};

/** Paiement CB via le pont TPE : phases WS, annulation, fallback « validée manuellement ». */
export function CbPaymentDialog({
  open,
  amountCents,
  onOpenChange,
  onApproved,
}: CbPaymentDialogProps) {
  const tpe = useTpePayment();
  const [manual, setManual] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const kind = amountCents < 0 ? 'credit' : 'debit';

  useEffect(() => {
    if (!open) {
      tpe.reset();
      setManual(false);
      setReason('');
      setCancelling(false);
      return;
    }
    void tpe.pay(amountCents, kind).then((result) => {
      if (result.status === 'approved') {
        onApproved({ amount_cents: amountCents, manual_fallback: false, tpe_response: result });
        onOpenChange(false);
      }
    });
    // pay/reset sont stables ; on ne relance qu'à l'ouverture.
  }, [open]);

  const retry = (): void => {
    setManual(false);
    void tpe.pay(amountCents, kind).then((result) => {
      if (result.status === 'approved') {
        onApproved({ amount_cents: amountCents, manual_fallback: false, tpe_response: result });
        onOpenChange(false);
      }
    });
  };

  const confirmManual = (): void => {
    const r = reason.trim();
    if (!r) return;
    void logEvent('manual_cb_fallback', {
      amount_cents: amountCents,
      reason: r,
      last_status: tpe.result?.status ?? null,
      txn_id: tpe.txnId,
    });
    onApproved({
      amount_cents: amountCents,
      manual_fallback: true,
      tpe_response: {
        reason: r,
        last_status: tpe.result?.status ?? null,
        bridge_txn_id: tpe.txnId,
      },
    });
    onOpenChange(false);
  };

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    await tpe.cancel();
    setCancelling(false);
    onOpenChange(false);
  };

  const inProgress = tpe.phase !== 'idle' && tpe.phase !== 'done';
  const failed = tpe.phase === 'done' && tpe.result && tpe.result.status !== 'approved';
  const canFallback =
    failed && (tpe.result?.status === 'timeout' || tpe.result?.status === 'error');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !inProgress && onOpenChange(false)}>
      <DialogContent
        hideClose
        className="max-w-md"
        onEscapeKeyDown={(e) => inProgress && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-accent" />{' '}
            {kind === 'credit' ? 'Remboursement CB' : 'Paiement CB'}
          </DialogTitle>
          <DialogDescription>Montant envoyé au terminal de paiement.</DialogDescription>
        </DialogHeader>
        <p className="text-center text-5xl font-bold tabular">
          {formatEurCents(Math.abs(amountCents))}
        </p>

        {inProgress && (
          <div className="flex flex-col items-center gap-3 py-2" data-testid="cb-progress">
            <Loader2 className="h-10 w-10 animate-spin text-accent" />
            <p className="text-lg">{PHASE_LABEL[tpe.phase]}</p>
            <ol className="flex gap-2 text-xs text-muted">
              {(['connecting', 'sent', 'waiting'] as const).map((p) => (
                <li key={p} className={tpe.phase === p ? 'text-accent' : ''}>
                  {PHASE_LABEL[p]}
                </li>
              ))}
            </ol>
            <Button
              variant="secondary"
              size="touch"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              Annuler
            </Button>
          </div>
        )}

        {tpe.phase === 'done' && tpe.result?.status === 'approved' && (
          <div className="flex items-center justify-center gap-2 text-success">
            <CheckCircle2 className="h-8 w-8" /> {STATUS_LABEL.approved}
          </div>
        )}

        {failed && !manual && (
          <div className="flex flex-col gap-3" data-testid="cb-failed">
            <div className="flex items-center gap-2 text-danger">
              <XCircle className="h-7 w-7 shrink-0" />
              <div>
                <p className="font-medium">{STATUS_LABEL[tpe.result?.status ?? 'error']}</p>
                {tpe.error && <p className="text-sm text-muted">{tpe.error}</p>}
                {tpe.result?.code && (
                  <p className="text-xs text-muted">Code TPE {tpe.result.code}</p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" size="touch" onClick={() => onOpenChange(false)}>
                Fermer
              </Button>
              <Button variant="secondary" size="touch" onClick={retry}>
                Réessayer
              </Button>
              {canFallback && (
                <Button
                  variant="warning"
                  size="touch"
                  onClick={() => setManual(true)}
                  data-testid="cb-manual"
                >
                  <AlertTriangle className="h-5 w-5" /> CB validée manuellement sur le TPE
                </Button>
              )}
            </div>
          </div>
        )}

        {manual && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              confirmManual();
            }}
          >
            <p className="text-sm text-warning">
              À n’utiliser que si le TPE a affiché « Paiement accepté » et imprimé son ticket.
              Journalisé (manual_cb_fallback).
            </p>
            <label className="flex flex-col gap-1.5 text-sm text-muted">
              Motif (obligatoire)
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
                placeholder="Ex. TPE hors réseau, ticket TPE n°…"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="touch"
                onClick={() => setManual(false)}
              >
                Retour
              </Button>
              <Button type="submit" variant="warning" size="touch" disabled={!reason.trim()}>
                Confirmer le paiement manuel
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
