import { describe, expect, it } from 'vitest';
import { encodeCp858, EscPosBuilder, displayWidth } from '../src/printer/escpos.js';
import { renderTicket, renderTicketLines } from '../src/printer/ticketRenderer.js';
import { referenceTicket } from './fixtures/ticket.js';

const textOf = (buffer: Buffer): string => buffer.toString('latin1');

describe('encodeCp858', () => {
  it('encode les accents, le symbole euro et les fallbacks', () => {
    expect([...encodeCp858('éèêàçùâîôûëïü')]).toEqual([
      0x82, 0x8a, 0x88, 0x85, 0x87, 0x97, 0x83, 0x8c, 0x93, 0x96, 0x89, 0x8b, 0x81,
    ]);
    expect([...encodeCp858('ÉÀÇ€')]).toEqual([0x90, 0xb7, 0x80, 0xd5]);
    expect(encodeCp858('œŒ').toString('latin1')).toBe('oeOE');
    expect(encodeCp858('1 234,56 €').toString('latin1')).toBe('1 234,56 \xd5');
    expect(encodeCp858('中').toString('latin1')).toBe('?');
    expect(encodeCp858('a\nb').toString('latin1')).toBe('a\nb');
  });
});

describe('EscPosBuilder', () => {
  it('émet les séquences attendues', () => {
    const buf = new EscPosBuilder()
      .init()
      .align('center')
      .bold(true)
      .size(2, 2)
      .line('A')
      .cut()
      .drawer(0)
      .build();
    expect(buf.toString('hex')).toBe('1b401b74131b61011b45011d2111410a1d5642001b700019fa');
  });
});

describe('renderTicket', () => {
  it('aucune ligne ne dépasse la largeur (42 colonnes, 21 en double largeur)', () => {
    for (const payload of [
      referenceTicket(),
      referenceTicket({
        duplicate: true,
        compliance: { ...referenceTicket().compliance, provisional: true },
      }),
    ]) {
      for (const line of renderTicketLines(payload, 42)) {
        const max = line.style?.size?.[0] === 2 ? 21 : 42;
        expect(displayWidth(line.text), line.text).toBeLessThanOrEqual(max);
      }
    }
  });

  it('contient les blocs de conformité et les libellés', () => {
    const text = textOf(renderTicket(referenceTicket()));
    expect(text).toContain('Ticket T-2026-000123');
    expect(text).toContain('Hash 1a2b3c4d');
    expect(text).toContain('Signature ABCDEF0123456789');
    expect(text).toContain('Ma Papeterie POS v0.1.0');
    expect(text).toContain('Carte bancaire');
    expect(text).toContain('Esp\x8aces');
    expect(text).toContain('Rendu');
    expect(text).toContain('Mairie de Chaumont');
    expect(text).not.toContain('DUPLICATA');
    expect(text.endsWith('\n\n\n\n\x1dVB\x00')).toBe(true);
  });

  it('DUPLICATA en grand quand duplicate=true', () => {
    const buf = renderTicket(referenceTicket({ duplicate: true }));
    const text = textOf(buf);
    expect(text).toContain('DUPLICATA');
    // GS ! 0x11 (double largeur + hauteur) précède le DUPLICATA d'en-tête.
    expect(buf.toString('hex')).toContain(
      '1d2111' + Buffer.from('DUPLICATA\n', 'latin1').toString('hex'),
    );
  });

  it('signature en attente et ticket provisoire', () => {
    const payload = referenceTicket({
      ticket_number: null,
      ticket_code: 'OFF-20260923-0007',
      compliance: {
        hash_short: 'deadbeef',
        signature_status: 'pending_signature',
        software: 'Ma Papeterie POS',
        version: '0.1.0',
        provisional: true,
      },
    });
    const text = textOf(renderTicket(payload));
    expect(text).toContain('Signature \x82lectronique en attente');
    expect(text).toContain('TICKET PROVISOIRE');
    expect(text).toContain('signature diff\x82r\x82e');
  });

  it('remboursement : quantités et montants négatifs', () => {
    const base = referenceTicket();
    const line = base.lines[0]!;
    const payload = referenceTicket({
      kind: 'refund',
      refund_of_ticket_code: 'T-2026-000100',
      lines: [{ ...line, qty: -1, line_ttc_cents: -1250 }],
      payments: [{ method: 'cash', label: 'Espèces', amount_cents: -1250 }],
      change_cents: 0,
      total_ttc_cents: -1250,
      total_vat_cents: -208,
      total_ht_cents: -1042,
      vat_breakdown: [{ rate: '20.00', base_ht_cents: -1042, vat_cents: -208, ttc_cents: -1250 }],
    });
    const lines = renderTicketLines(payload).map((l) => l.text);
    expect(lines).toContain(' '.repeat(14) + 'REMBOURSEMENT');
    expect(lines.some((l) => l.startsWith('  -1 x 12,50'))).toBe(true);
    expect(lines.some((l) => l.includes('-12,50'))).toBe(true);
  });

  it('snapshot du buffer et de la mise en page de référence', () => {
    const buffer = renderTicket(referenceTicket());
    expect(
      renderTicketLines(referenceTicket())
        .map((l) => l.text)
        .join('\n'),
    ).toMatchSnapshot();
    expect(buffer.toString('hex')).toMatchSnapshot();
  });
});
