import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildReport, type ReportPayload } from '@pos/core';
import { parseConfig } from '../src/config.js';
import { buildDrawerCommand, encodeLines } from '../src/printer/builder.js';
import { displayWidth } from '../src/printer/escpos.js';
import { renderReport, renderReportLines } from '../src/printer/reportRenderer.js';
import { StarLineBuilder } from '../src/printer/starline.js';
import { renderTicket, renderTicketLines } from '../src/printer/ticketRenderer.js';
import { DevicePrinter, NullPrinter, PrinterError } from '../src/printer/transport.js';
import { buildServer } from '../src/server.js';
import { referenceTicket } from './fixtures/ticket.js';

const STAR = { commandSet: 'star', cutter: false } as const;
/** `formatEurCents` sépare les milliers par une espace fine insécable (U+202F). */
const spaces = (text: string): string => text.replace(/[\u202f\u00a0]/g, ' ');
const TOKEN = 'test-token-0123456789abcdef';

function report(patch: Partial<Parameters<typeof buildReport>[1]> = {}): ReportPayload {
  return buildReport(
    {
      txn_count: 128,
      sales_count: 126,
      refunds_count: 2,
      first_ticket_number: 1001,
      last_ticket_number: 1128,
      total_ht_cents: 10_287_523,
      total_vat_cents: 2_057_505,
      total_ttc_cents: 12_345_028,
      refunds_ttc_cents: -4_590,
      vat_breakdown: [
        { rate: '5.50', base_ht_cents: 94_787, vat_cents: 5_213, ttc_cents: 100_000 },
        { rate: '20.00', base_ht_cents: 10_192_736, vat_cents: 2_052_292, ttc_cents: 12_245_028 },
      ],
      payments: [
        { method: 'cb', amount_cents: 9_000_000, count: 90 },
        { method: 'cash', amount_cents: 3_345_028, count: 38 },
      ],
      change_cents: 12_300,
      cash: {
        opening_float_cents: 15_000,
        expected_cash_cents: 3_347_728,
        counted_cash_cents: 3_347_700,
        variance_cents: -28,
      },
      grand_total_perpetual_cents: 1_234_567_890,
    },
    {
      kind: 'Z1',
      register_code: 'C01',
      header: referenceTicket().header,
      period_start: '2026-09-28T07:00:00.000Z',
      period_end: '2026-09-28T17:00:00.000Z',
      printed_at: '2026-09-28T17:01:00.000Z',
      app_version: '0.3.0',
      number: 57,
      session_number: 57,
      hash: 'a1b2c3d4e5f6a7b8c9d0',
      ...patch,
    },
  );
}

describe('StarLineBuilder', () => {
  it('émet les commandes Star Line Mode / StarPRNT', () => {
    const buf = new StarLineBuilder()
      .init()
      .align('center')
      .bold(true)
      .size(2, 2)
      .line('A')
      .bold(false)
      .cut()
      .drawer(0)
      .drawer(1)
      .build();
    expect(buf.toString('hex')).toBe(
      '1b40' +
        '1b1d7404' +
        '1b1d6101' +
        '1b45' +
        '1b690101' +
        '410a' +
        '1b46' +
        '1b6403' +
        '07' +
        '1a',
    );
  });

  it('page de codes forcée', () => {
    expect(new StarLineBuilder(32).init().build().toString('hex')).toBe('1b401b1d7420');
  });

  it('tiroir : BEL en Star, ESC p en ESC/POS', () => {
    expect(buildDrawerCommand(0, { commandSet: 'star' }).toString('hex')).toBe('1b4007');
    expect(buildDrawerCommand(0, { commandSet: 'escpos' }).toString('hex')).toBe('1b401b700019fa');
  });

  it('sans massicot : avance de 5 lignes, aucune coupe', () => {
    const buf = encodeLines([{ text: 'x' }], STAR);
    expect(buf.toString('hex').endsWith('780a' + '1b1d6100' + '0a'.repeat(5))).toBe(true);
    expect(buf.includes(Buffer.from([0x1b, 0x64]))).toBe(false);
  });
});

describe('ticket 58 mm (32 colonnes)', () => {
  const payloads = [
    referenceTicket(),
    referenceTicket({ duplicate: true }),
    referenceTicket({
      ticket_code: 'FORM-0003',
      ticket_number: null,
      compliance: { ...referenceTicket().compliance, hash_short: '', training: true },
    }),
  ];

  it('aucune ligne ne dépasse 32 colonnes (16 en double largeur)', () => {
    for (const payload of payloads) {
      for (const line of renderTicketLines(payload, 32)) {
        const max = line.style?.size?.[0] === 2 ? 16 : 32;
        expect(displayWidth(line.text), line.text).toBeLessThanOrEqual(max);
      }
    }
  });

  it('TVA empilée : montants jamais tronqués', () => {
    const payload = referenceTicket({
      vat_breakdown: [
        { rate: '20.00', base_ht_cents: 102_875, vat_cents: 20_575, ttc_cents: 123_450 },
      ],
    });
    const text = spaces(
      renderTicketLines(payload, 32)
        .map((l) => l.text)
        .join('\n'),
    );
    expect(text).toContain('TTC 1 234,50');
    expect(text).toContain('HT 1 028,75');
    expect(text).toContain('TVA 205,75');
  });

  it('encodage Star : page de codes CP858, pas de commande ESC/POS', () => {
    const buf = renderTicket(referenceTicket(), 32, STAR);
    expect(buf.subarray(0, 6).toString('hex')).toBe('1b401b1d7404');
    expect(buf.includes(Buffer.from([0x1d, 0x21]))).toBe(false); // GS ! (taille Epson)
    expect(buf.includes(Buffer.from([0x1d, 0x56]))).toBe(false); // GS V (coupe Epson)
    expect(buf.toString('latin1')).toContain('Esp\x8aces');
  });

  it('ticket de formation : mentions, pas de hash ni de signature', () => {
    const text = renderTicket(payloads[2]!, 32, STAR).toString('latin1');
    expect(text).toContain('FORMATION');
    expect(text).toContain('Formation : aucune empreinte');
    expect(text).not.toContain('Signature');
  });
});

describe('rapports X / Z', () => {
  it('toutes largeurs : lignes dans la largeur, montants intacts', () => {
    for (const width of [32, 42, 48]) {
      const lines = renderReportLines(report(), width);
      for (const line of lines) {
        const max = line.style?.size?.[0] === 2 ? Math.floor(width / 2) : width;
        expect(displayWidth(line.text), `${width}: ${line.text}`).toBeLessThanOrEqual(max);
      }
      const text = spaces(lines.map((l) => l.text).join('\n'));
      expect(text).toContain('123 450,28');
      expect(text).toContain('12 345 678,90');
      expect(text).toContain('CLÔTURE JOURNALIÈRE Z1');
    }
  });

  it('valeur trop longue reportée à la ligne suivante, alignée à droite', () => {
    const lines = renderReportLines(report(), 32).map((l) => spaces(l.text));
    const i = lines.findIndex((l) => l.startsWith('Grand total perpétuel'));
    expect(lines[i]).toBe('Grand total perpétuel');
    expect(lines[i + 1]).toMatch(/^ +12 345 678,90 €$/);
    expect(displayWidth(lines[i + 1]!)).toBe(32);
  });

  it('X de formation : mentions', () => {
    const text = renderReport(report({ kind: 'X', training: true, period_end: null }), 42).toString(
      'latin1',
    );
    expect(text).toContain('LECTURE X');
    expect(text).toContain('Document non fiscal');
    expect(text).toContain('FORMATION');
  });
});

describe('configuration', () => {
  it('profil star-mpop : Star, 32 colonnes, sans massicot', () => {
    const cfg = parseConfig({
      token: TOKEN,
      printer: { profile: 'star-mpop', type: 'device', path: '/dev/usb/lp0' },
    });
    expect(cfg.printer).toMatchObject({
      commandSet: 'star',
      width: 32,
      cutter: false,
      type: 'device',
      path: '/dev/usb/lp0',
    });
  });

  it('une valeur explicite l’emporte sur le profil', () => {
    const cfg = parseConfig({ token: TOKEN, printer: { profile: 'star-mpop', width: 30 } });
    expect(cfg.printer.width).toBe(30);
    expect(cfg.printer.commandSet).toBe('star');
  });

  it('device exige path ; défaut ESC/POS 42 colonnes', () => {
    expect(() => parseConfig({ token: TOKEN, printer: { type: 'device' } })).toThrow(/path/);
    const cfg = parseConfig({ token: TOKEN });
    expect(cfg.printer).toMatchObject({ commandSet: 'escpos', width: 42, cutter: true });
  });
});

describe('DevicePrinter', () => {
  it('écrit le buffer RAW dans le périphérique', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-dev-'));
    const path = join(dir, 'lp0');
    writeFileSync(path, '');
    const printer = new DevicePrinter({ path });
    expect(await printer.reachable()).toBe(true);
    await Promise.all([printer.print(Buffer.from('AB')), printer.print(Buffer.from('CD'))]);
    // `r+` écrit en début de fichier : le 2e travail écrase le 1er sur un fichier ordinaire,
    // mais les deux écritures sont bien sérialisées (pas d'entrelacement).
    expect(readFileSync(path, 'latin1')).toBe('CD');
  });

  it('périphérique absent : injoignable et PrinterError', async () => {
    const printer = new DevicePrinter({ path: join(tmpdir(), 'pos-absent', 'lp9') });
    expect(await printer.reachable()).toBe(false);
    await expect(printer.print(Buffer.from('x'))).rejects.toBeInstanceOf(PrinterError);
  });
});

describe('routes (profil Star mPOP)', () => {
  it('/print/report, /drawer/open et /health en Star', async () => {
    const printer = new NullPrinter();
    const server = await buildServer({
      config: parseConfig({
        token: TOKEN,
        tpe: { simulate: true },
        printer: { profile: 'star-mpop', type: 'none' },
      }),
      version: 'test',
      logger: pino({ level: 'silent' }),
      tpeEndpoint: { host: '127.0.0.1', port: 1 },
      printer,
    });
    await server.app.ready();
    try {
      const headers = { 'x-bridge-token': TOKEN };
      const res = await server.app.inject({
        method: 'POST',
        url: '/print/report',
        headers,
        payload: report(),
      });
      expect(res.statusCode).toBe(200);
      expect(printer.jobs.at(-1)?.subarray(0, 6).toString('hex')).toBe('1b401b1d7404');

      const bad = await server.app.inject({
        method: 'POST',
        url: '/print/report',
        headers,
        payload: { ...report(), sections: [] },
      });
      expect(bad.statusCode).toBe(400);

      await server.app.inject({
        method: 'POST',
        url: '/drawer/open',
        headers,
        payload: { reason: 'cash' },
      });
      expect(printer.jobs.at(-1)?.toString('hex')).toBe('1b4007');

      const health = await server.app.inject({ method: 'GET', url: '/health' });
      expect(health.json().printer).toMatchObject({ command_set: 'star', width: 32 });
    } finally {
      await server.app.close();
    }
  });
});
