import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { bridge } from '@/lib/bridge';
import { useUiStore } from '@/stores/uiStore';
import { ReceiptPreview } from './ReceiptPreview';

/** Affichage plein écran du ticket quand l'imprimante / le pont est indisponible. */
export function ReceiptFallbackDialog() {
  const ticket = useUiStore((s) => s.receiptFallback);
  const show = useUiStore((s) => s.showReceiptFallback);
  const toast = useUiStore((s) => s.toast);

  const retry = async (): Promise<void> => {
    if (!ticket) return;
    try {
      const r = await bridge.print(ticket);
      if (r.ok) {
        toast({ title: 'Ticket imprimé', variant: 'success' });
        show(null);
        return;
      }
      throw new Error('Impression refusée');
    } catch (e) {
      toast({
        title: 'Impression impossible',
        description: e instanceof Error ? e.message : undefined,
        variant: 'danger',
      });
    }
  };

  return (
    <Dialog open={ticket !== null} onOpenChange={(o) => !o && show(null)}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Ticket (imprimante indisponible)</DialogTitle>
          <DialogDescription>
            Le ticket n’a pas pu être imprimé. Montrez-le au client ou réessayez l’impression.
          </DialogDescription>
        </DialogHeader>
        {ticket && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ReceiptPreview ticket={ticket} />
          </div>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" size="touch" onClick={() => show(null)}>
            Fermer
          </Button>
          <Button size="touch" onClick={() => void retry()}>
            <Printer className="h-5 w-5" /> Réessayer l’impression
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
