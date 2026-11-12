import { useEffect, useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
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
import { describeApiError } from '@/lib/apiError';
import { edge } from '@/lib/edge';
import { logEvent } from '@/lib/events';

export interface SendInvoiceEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionId: string;
  ticketCode: string;
  /** Adresse proposée (en-tête de facture de la personne de passage). */
  defaultEmail?: string | null;
  onSent?: () => void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Envoi par e-mail de la facture d'un ticket passé (Historique). Le contenu est reconstruit côté
 * serveur depuis la base (`pos-send-receipt`, `document: 'invoice'`) ; l'adresse n'est pas conservée.
 */
export function SendInvoiceEmailDialog({
  open,
  onOpenChange,
  transactionId,
  ticketCode,
  defaultEmail = null,
  onSent,
}: SendInvoiceEmailDialogProps) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail(defaultEmail ?? '');
    setError(null);
  }, [open, defaultEmail]);

  const valid = EMAIL_RE.test(email.trim());

  const send = async (): Promise<void> => {
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    try {
      await edge.sendReceipt({
        transaction_id: transactionId,
        channel: 'email',
        to: email.trim(),
        document: 'invoice',
      });
      void logEvent('receipt_delivery', {
        channel: 'email_invoice',
        ticket_code: ticketCode,
        transaction_id: transactionId,
        reprint: true,
      });
      onSent?.();
      onOpenChange(false);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Facture par e-mail</DialogTitle>
          <DialogDescription>
            Envoie la facture du ticket {ticketCode}. L’adresse n’est pas conservée.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Input
            type="email"
            inputMode="email"
            autoComplete="off"
            autoFocus
            placeholder="client@exemple.fr"
            value={email}
            onChange={(e) => {
              setError(null);
              setEmail(e.target.value);
            }}
            data-testid="invoice-email-input"
          />
          {error && (
            <p className="text-sm text-danger" role="alert" data-testid="invoice-email-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => onOpenChange(false)}
            >
              Annuler
            </Button>
            <Button
              type="submit"
              size="touch"
              disabled={!valid || sending}
              data-testid="invoice-email-send"
            >
              {sending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Mail className="h-5 w-5" />
              )}
              Envoyer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
