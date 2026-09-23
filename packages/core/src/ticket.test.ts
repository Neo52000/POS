import { describe, expect, it } from 'vitest';

import { buildTicketCode, hashShort, paymentMethodLabel } from './ticket.js';

describe('buildTicketCode', () => {
  it('pads the number on 6 digits', () => {
    expect(buildTicketCode(2026, 123)).toBe('T-2026-000123');
    expect(buildTicketCode(2026, 1)).toBe('T-2026-000001');
    expect(buildTicketCode(2027, 1234567)).toBe('T-2027-1234567');
  });

  it('rejects invalid inputs', () => {
    expect(() => buildTicketCode(2026, -1)).toThrow(RangeError);
    expect(() => buildTicketCode(2026.5, 1)).toThrow(RangeError);
  });
});

describe('paymentMethodLabel', () => {
  it('returns SPEC §6 labels', () => {
    expect(paymentMethodLabel('cb')).toBe('Carte bancaire');
    expect(paymentMethodLabel('cash')).toBe('Espèces');
    expect(paymentMethodLabel('cheque')).toBe('Chèque');
    expect(paymentMethodLabel('gift_ucia')).toBe('Bon cadeau UCIA');
    expect(paymentMethodLabel('transfer')).toBe('Virement');
  });
});

describe('hashShort', () => {
  it('returns the first 8 hex characters', () => {
    expect(hashShort('ABCDEF0123456789')).toBe('abcdef01');
  });
});
