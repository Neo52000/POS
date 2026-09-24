import { useState } from 'react';
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
import type { QueuedCheckout } from '@/lib/db';
import { formatDateTime, formatEurCents } from '@/lib/format';
import { ABANDON_REASON_MIN, abandonQueueItem } from '@/lib/offlineQueue';
import { errorMessage } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';

interface AbandonDialogProps {
  item: QueuedCheckout | null;
  onClose: () => void;
}

/**
 * Abandon d'une vente en échec (admin) : motif obligatoire, trace JET `offline_sale_abandoned`
 * enregistrée côté serveur avant le changement de statut local. Rien n'est supprimé.
 */
export function AbandonDialog({ item, onClose }: AbandonDialogProps) {
  const toast = useUiStore((s) => s.toast);
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = reason.trim().length >= ABANDON_REASON_MIN && !offline;

  const close = (): void => {
    setReason('');
    onClose();
  };

  const confirm = async (): Promise<void> => {
    if (!item) return;
    setBusy(true);
    try {
      await abandonQueueItem(item.client_txn_id, reason);
      toast({
        title: 'Vente abandonnée',
        description:
          'Trace enregistrée au journal. Ressaisissez la vente en ligne si elle doit être comptabilisée.',
        variant: 'success',
      });
      close();
    } catch (e) {
      toast({ title: 'Abandon impossible', description: errorMessage(e), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Abandonner {item?.provisional_ref ?? 'la vente'}</DialogTitle>
          <DialogDescription>
            La vente ne sera pas enregistrée en caisse. Son contenu complet et votre motif sont
            conservés dans le journal des événements (JET), chaîné et archivé.
          </DialogDescription>
        </DialogHeader>
        {item && (
          <div className="rounded-xl border border-border p-3 text-sm">
            <p>
              {formatDateTime(item.business_at)} ·{' '}
              <span className="font-semibold tabular">
                {formatEurCents(item.payload.totals.total_ttc_cents)}
              </span>
            </p>
            <p className="text-danger">
              {item.last_error_code ? `${item.last_error_code} · ` : ''}
              {item.last_error ?? ''}
            </p>
          </div>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Motif ({ABANDON_REASON_MIN} caractères minimum)
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="ex. vente ressaisie en ligne sous le ticket T-2026-000123"
            data-testid="abandon-reason"
          />
        </label>
        {offline && <p className="text-sm text-warning">Abandon possible uniquement en ligne.</p>}
        <DialogFooter>
          <Button variant="secondary" size="touch" onClick={close}>
            Annuler
          </Button>
          <Button
            variant="danger"
            size="touch"
            disabled={!valid || busy}
            onClick={() => void confirm()}
            data-testid="abandon-confirm"
          >
            Abandonner
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
