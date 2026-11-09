import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({ edge: { sendReceipt: vi.fn() } }));

import { ApiError } from '@/lib/apiError';
import { edge } from '@/lib/edge';
import { logEvent } from '@/lib/events';
import { ReceiptChoice, isValidMobile } from './ReceiptChoice';

const TXN = 'a0000000-0000-4000-8000-0000000000aa';

function setup(props: Partial<Parameters<typeof ReceiptChoice>[0]> = {}) {
  const onPrint = vi.fn();
  const onDone = vi.fn();
  render(
    <ReceiptChoice
      transactionId={TXN}
      ticketCode="T-2026-000042"
      onPrint={onPrint}
      onDone={onDone}
      {...props}
    />,
  );
  return { onPrint, onDone };
}

describe('ReceiptChoice', () => {
  beforeEach(() => {
    vi.mocked(edge.sendReceipt).mockReset();
    vi.mocked(logEvent).mockClear();
  });

  it('imprime le ticket papier seulement à la demande et journalise le choix', () => {
    const { onPrint, onDone } = setup();
    expect(onPrint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('receipt-paper'));
    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('paper');
    expect(logEvent).toHaveBeenCalledWith('receipt_delivery', {
      channel: 'paper',
      ticket_code: 'T-2026-000042',
      transaction_id: TXN,
    });
    expect(screen.getByTestId('receipt-done')).toHaveTextContent('Ticket imprimé');
  });

  it('« Aucun ticket » ne déclenche ni impression ni envoi', () => {
    const { onPrint, onDone } = setup();
    fireEvent.click(screen.getByTestId('receipt-none'));
    expect(onPrint).not.toHaveBeenCalled();
    expect(edge.sendReceipt).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith('none');
  });

  it('envoie par e-mail à l’adresse du client pré-remplie', async () => {
    vi.mocked(edge.sendReceipt).mockResolvedValue({ ok: true, ticket_code: 'T-2026-000042' });
    const { onDone } = setup({ defaultEmail: 'compta@client.fr' });
    fireEvent.click(screen.getByTestId('receipt-email'));
    expect(screen.getByTestId('receipt-to')).toHaveValue('compta@client.fr');
    fireEvent.click(screen.getByTestId('receipt-send'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('email'));
    expect(edge.sendReceipt).toHaveBeenCalledWith({
      transaction_id: TXN,
      channel: 'email',
      to: 'compta@client.fr',
    });
    // Le destinataire n'est pas journalisé.
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain('compta@client.fr');
  });

  it('bloque un mobile invalide et affiche l’erreur d’envoi sans clore le choix', async () => {
    vi.mocked(edge.sendReceipt).mockRejectedValue(
      new ApiError('DELIVERY_FAILED', 'Brevo : not enough credits'),
    );
    const { onDone } = setup();
    fireEvent.click(screen.getByTestId('receipt-sms'));
    fireEvent.change(screen.getByTestId('receipt-to'), { target: { value: '01 23' } });
    expect(screen.getByTestId('receipt-send')).toBeDisabled();
    fireEvent.change(screen.getByTestId('receipt-to'), { target: { value: '06 12 34 56 78' } });
    fireEvent.click(screen.getByTestId('receipt-send'));
    expect(await screen.findByTestId('receipt-error')).toHaveTextContent('not enough credits');
    expect(onDone).not.toHaveBeenCalled();
    // Repli : retour au choix puis ticket papier.
    fireEvent.click(screen.getByRole('button', { name: /Retour/ }));
    fireEvent.click(screen.getByTestId('receipt-paper'));
    expect(onDone).toHaveBeenCalledWith('paper');
  });

  it('désactive e-mail et SMS sans transaction enregistrée (hors ligne, formation)', () => {
    setup({ transactionId: null, digitalUnavailableReason: 'Hors ligne' });
    expect(screen.getByTestId('receipt-email')).toBeDisabled();
    expect(screen.getByTestId('receipt-sms')).toBeDisabled();
    expect(screen.getByTestId('receipt-paper')).toBeEnabled();
    expect(screen.getByTestId('receipt-digital-unavailable')).toHaveTextContent('Hors ligne');
  });

  it('valide les formats de mobile', () => {
    expect(isValidMobile('06 12 34 56 78')).toBe(true);
    expect(isValidMobile('+33 6 12 34 56 78')).toBe(true);
    expect(isValidMobile('0033612345678')).toBe(true);
    expect(isValidMobile('03 25 00 00 00')).toBe(false);
    expect(isValidMobile('12345')).toBe(false);
  });
});

describe('ReceiptChoice — facture A4', () => {
  beforeEach(() => vi.mocked(logEvent).mockClear());

  it('sans onPrintInvoice : aucun choix facture', () => {
    setup();
    expect(screen.queryByTestId('receipt-invoice_a4')).toBeNull();
    expect(screen.queryByTestId('receipt-paper_invoice_a4')).toBeNull();
  });

  it('« Facture A4 » n’imprime que la facture', () => {
    const onPrintInvoice = vi.fn();
    const { onPrint, onDone } = setup({ onPrintInvoice });
    fireEvent.click(screen.getByTestId('receipt-invoice_a4'));
    expect(onPrintInvoice).toHaveBeenCalledTimes(1);
    expect(onPrint).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith('invoice_a4');
  });

  it('« Ticket + facture A4 » imprime les deux', () => {
    const onPrintInvoice = vi.fn();
    const { onPrint, onDone } = setup({ onPrintInvoice });
    fireEvent.click(screen.getByTestId('receipt-paper_invoice_a4'));
    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(onPrintInvoice).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('paper_invoice_a4');
    expect(logEvent).toHaveBeenCalledWith(
      'receipt_delivery',
      expect.objectContaining({ channel: 'paper_invoice_a4' }),
    );
  });
});
