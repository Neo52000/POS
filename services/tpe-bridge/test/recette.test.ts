import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { displayWidth } from '../src/printer/escpos.js';
import { renderTicketLines } from '../src/printer/ticketRenderer.js';
import { codepagePage, encodeCp1252, sampleTicket, stepBuffers } from '../src/recette.js';

const mpop = parseConfig({
  token: 'test-token-0123456789abcdef',
  printer: { profile: 'star-mpop' },
});

describe('recette imprimante', () => {
  it('page de codes Star : bascule 4 puis 32 puis retour à la page configurée', () => {
    const hex = codepagePage({ commandSet: 'star', cutter: false }, 32).toString('hex');
    const i4 = hex.indexOf('1b1d7404', 12);
    const i32 = hex.indexOf('1b1d7420');
    expect(i4).toBeGreaterThan(0);
    expect(i32).toBeGreaterThan(i4);
    expect(hex.indexOf('1b1d7404', i32)).toBeGreaterThan(i32);
    expect(hex).not.toContain('1b6403'); // pas de coupe sans massicot
  });

  it('CP1252 : € en 0x80, accents Latin-1', () => {
    expect([...encodeCp1252('é€œ')]).toEqual([0xe9, 0x80, 0x9c]);
  });

  it('toutes les étapes produisent un document Star ; tiroir = BEL', () => {
    for (const step of ['codepage', 'ticket', 'formation', 'rapport'] as const) {
      expect(stepBuffers(step, mpop).subarray(0, 2).toString('hex')).toBe('1b40');
    }
    expect(stepBuffers('tiroir', mpop).toString('hex')).toBe('1b4007');
  });

  it('ticket de recette : 32 colonnes, montant long complet', () => {
    const lines = renderTicketLines(sampleTicket(), 32);
    for (const l of lines) {
      expect(displayWidth(l.text)).toBeLessThanOrEqual(l.style?.size?.[0] === 2 ? 16 : 32);
    }
    expect(lines.map((l) => l.text.replace(/[\u202f\u00a0]/g, ' ')).join('\n')).toContain(
      '1 234,56',
    );
  });
});
