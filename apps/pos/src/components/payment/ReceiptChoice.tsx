import { useState } from 'react';
import { ArrowLeft, Ban, Check, Loader2, Mail, MessageSquare, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeApiError, isApiError } from '@/lib/apiError';
import { edge } from '@/lib/edge';
import type { ReceiptChannel } from '@/lib/edge';
import { logEvent } from '@/lib/events';
import { cn } from '@/lib/utils';

export type ReceiptDelivery = 'paper' | ReceiptChannel | 'none';

export interface ReceiptChoiceProps {
  /** Vente enregistrée côté serveur : null (formation, hors ligne) → e-mail / SMS indisponibles. */
  transactionId: string | null;
  ticketCode: string;
  /** Pourquoi l'envoi dématérialisé est indisponible (affiché sous les boutons). */
  digitalUnavailableReason?: string | null;
  defaultEmail?: string | null;
  defaultPhone?: string | null;
  onPrint: () => void;
  /** Choix terminé (ticket imprimé, envoyé ou refusé). */
  onDone: (delivery: ReceiptDelivery) => void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Mobile FR (06/07) ou numéro international (+…) : contrôle de forme, normalisé côté serveur. */
export function isValidMobile(raw: string): boolean {
  const d = raw.replace(/[^\d+]/g, '');
  return /^0[67]\d{8}$/.test(d) || /^(\+|00)[1-9]\d{7,14}$/.test(d);
}

const LABELS: Record<ReceiptDelivery, string> = {
  paper: 'Ticket imprimé',
  email: 'Ticket envoyé par e-mail',
  sms: 'Ticket envoyé par SMS',
  none: 'Pas de ticket',
};

/**
 * Choix du ticket après encaissement (loi AGEC : pas d'impression systématique) :
 * papier, e-mail, SMS ou aucun. Le choix est journalisé, sans le destinataire.
 */
export function ReceiptChoice({
  transactionId,
  ticketCode,
  digitalUnavailableReason = null,
  defaultEmail = null,
  defaultPhone = null,
  onPrint,
  onDone,
}: ReceiptChoiceProps) {
  const [step, setStep] = useState<'choose' | ReceiptChannel>('choose');
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [phone, setPhone] = useState(defaultPhone ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReceiptDelivery | null>(null);

  const digitalOk = !!transactionId && !digitalUnavailableReason;

  const finish = (delivery: ReceiptDelivery): void => {
    setDone(delivery);
    void logEvent('receipt_delivery', {
      channel: delivery,
      ticket_code: ticketCode,
      transaction_id: transactionId,
    });
    onDone(delivery);
  };

  const send = async (channel: ReceiptChannel): Promise<void> => {
    if (!transactionId || sending) return;
    const to = channel === 'email' ? email.trim() : phone.trim();
    setSending(true);
    setError(null);
    try {
      await edge.sendReceipt({ transaction_id: transactionId, channel, to });
      finish(channel);
    } catch (e) {
      setError(
        isApiError(e) && e.code === 'DELIVERY_FAILED' && e.message !== e.code
          ? e.message
          : describeApiError(e),
      );
    } finally {
      setSending(false);
    }
  };

  if (done) {
    return (
      <p
        className="flex items-center gap-2 text-lg font-medium text-success"
        data-testid="receipt-done"
      >
        <Check className="h-5 w-5" /> {LABELS[done]}
      </p>
    );
  }

  if (step !== 'choose') {
    const isEmail = step === 'email';
    const value = isEmail ? email : phone;
    const valid = isEmail ? EMAIL_RE.test(value.trim()) : isValidMobile(value);
    return (
      <form
        className="flex w-full max-w-md flex-col gap-3"
        data-testid="receipt-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void send(step);
        }}
      >
        <label className="text-base font-medium" htmlFor="receipt-to">
          {isEmail ? 'Adresse e-mail du client' : 'Mobile du client'}
        </label>
        <Input
          id="receipt-to"
          autoFocus
          type={isEmail ? 'email' : 'tel'}
          inputMode={isEmail ? 'email' : 'tel'}
          autoComplete="off"
          placeholder={isEmail ? 'client@exemple.fr' : '06 12 34 56 78'}
          value={value}
          onChange={(e) => {
            setError(null);
            if (isEmail) setEmail(e.target.value);
            else setPhone(e.target.value);
          }}
          className="text-center text-xl"
          data-testid="receipt-to"
        />
        {error && (
          <p className="text-sm text-danger" role="alert" data-testid="receipt-error">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="touch"
            onClick={() => {
              setError(null);
              setStep('choose');
            }}
            disabled={sending}
          >
            <ArrowLeft className="h-5 w-5" /> Retour
          </Button>
          <Button
            type="submit"
            size="touch"
            className="flex-1"
            disabled={!valid || sending}
            data-testid="receipt-send"
          >
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
            Envoyer {isEmail ? 'l’e-mail' : 'le SMS'}
          </Button>
        </div>
      </form>
    );
  }

  const options: Array<{
    key: ReceiptDelivery;
    label: string;
    icon: typeof Printer;
    disabled?: boolean;
    onClick: () => void;
  }> = [
    {
      key: 'paper',
      label: 'Ticket papier',
      icon: Printer,
      onClick: () => {
        onPrint();
        finish('paper');
      },
    },
    {
      key: 'email',
      label: 'E-mail',
      icon: Mail,
      disabled: !digitalOk,
      onClick: () => setStep('email'),
    },
    {
      key: 'sms',
      label: 'SMS',
      icon: MessageSquare,
      disabled: !digitalOk,
      onClick: () => setStep('sms'),
    },
    { key: 'none', label: 'Aucun ticket', icon: Ban, onClick: () => finish('none') },
  ];

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-2" data-testid="receipt-choice">
      <p className="text-base text-muted">Ticket client ?</p>
      <div className="grid w-full grid-cols-4 gap-2">
        {options.map(({ key, label, icon: Icon, disabled, onClick }) => (
          <Button
            key={key}
            variant={key === 'none' ? 'secondary' : 'default'}
            size="touch"
            className={cn('h-20 flex-col gap-1 text-base', key === 'none' && 'text-muted')}
            disabled={disabled}
            onClick={onClick}
            data-testid={`receipt-${key}`}
          >
            <Icon className="h-6 w-6" />
            {label}
          </Button>
        ))}
      </div>
      {!digitalOk && (
        <p className="text-sm text-muted" data-testid="receipt-digital-unavailable">
          {digitalUnavailableReason ?? 'E-mail et SMS disponibles après enregistrement en ligne.'}
        </p>
      )}
    </div>
  );
}
