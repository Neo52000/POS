/**
 * Recette de l'imprimante (Star mPOP ou ESC/POS) depuis le PC comptoir, sans la caisse :
 * mêmes configuration, rendu et transport que le pont.
 *
 *   node dist/recette.js [étape…] [--config <bridge.config.json>] [--out <dossier>]
 *   pnpm --filter @pos/tpe-bridge recette [étape…]
 *
 * Étapes (défaut : toutes, dans l'ordre) : diag, codepage, ticket, formation, rapport, tiroir.
 * `--out` écrit les fichiers `.bin` au lieu d'imprimer (test `copy /b fichier.bin \\localhost\mPOP`).
 * Le pont peut rester démarré : une impression n'a pas besoin de connexion exclusive.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildReport, type TicketPayload } from '@pos/core';
import { ConfigError, loadConfig, resolveConfigPath, type BridgeConfig } from './config.js';
import { buildDrawerCommand, createCommands, type OutputOptions } from './printer/builder.js';
import { encodeCp858 } from './printer/escpos.js';
import { renderReport } from './printer/reportRenderer.js';
import { renderTicket } from './printer/ticketRenderer.js';
import { createPrinter, PrinterError } from './printer/transport.js';

export const RECETTE_STEPS = [
  'diag',
  'codepage',
  'ticket',
  'formation',
  'rapport',
  'tiroir',
] as const;
export type RecetteStep = (typeof RECETTE_STEPS)[number];

const ACCENTS = 'é è ê à ù ç ô î « » € £ °';

/** CP1252 (Windows Latin-1) : Latin-1 + `€` en 0x80, `œ` 0x9C, `Œ` 0x8C. */
export function encodeCp1252(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (char === '€') bytes.push(0x80);
    else if (char === 'œ') bytes.push(0x9c);
    else if (char === 'Œ') bytes.push(0x8c);
    else if (code <= 0xff) bytes.push(code);
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

/**
 * Page de diagnostic : identifie la page de codes et l'émulation réellement actives.
 * Chaque ligne numérotée sélectionne une page de codes puis imprime les mêmes accents : la ligne
 * lisible donne la valeur de `printer.codepageNumber`. Les lignes GRAS / DOUBLE vérifient que
 * l'imprimante interprète bien le jeu de commandes configuré (sinon : lettres parasites).
 */
export function codepagePage(output: OutputOptions, width: number): Buffer {
  const candidates: Array<{ n: number; label: string; encode: (t: string) => Buffer }> =
    output.commandSet === 'star'
      ? [
          { n: 4, label: 'CP858', encode: encodeCp858 },
          { n: 32, label: 'CP1252', encode: encodeCp1252 },
        ]
      : [
          { n: 19, label: 'CP858', encode: encodeCp858 },
          { n: 16, label: 'CP1252', encode: encodeCp1252 },
        ];
  const b = createCommands(output).init();
  b.align('center').bold(true).size(2, 2).line('RECETTE');
  b.size(1, 1).line('Page de codes / emulation').bold(false).align('left');
  b.line('-'.repeat(width));
  b.line(`Jeu de commandes : ${output.commandSet}`);
  b.line(`Largeur : ${width} colonnes`);
  b.line('-'.repeat(width));
  for (const c of candidates) {
    const cmd = output.commandSet === 'star' ? [0x1b, 0x1d, 0x74, c.n] : [0x1b, 0x74, c.n];
    b.raw(...cmd);
    b.text(`[${c.n}] ${c.label}: `);
    b.raw(...c.encode(ACCENTS));
    b.line();
  }
  // Retour à la page de codes configurée.
  const configured = output.codepageNumber ?? (output.commandSet === 'star' ? 4 : 19);
  b.raw(
    ...(output.commandSet === 'star' ? [0x1b, 0x1d, 0x74, configured] : [0x1b, 0x74, configured]),
  );
  b.line('-'.repeat(width));
  b.line('Ligne lisible = valeur de');
  b.line(`"codepageNumber" (actuelle : ${configured})`);
  b.line('-'.repeat(width));
  b.bold(true).line('GRAS').bold(false);
  b.size(2, 2).line('DOUBLE').size(1, 1);
  b.align('center').line('CENTRE').align('right').line('DROITE').align('left');
  b.line('Lettres parasites autour de');
  b.line('GRAS/DOUBLE = mauvais jeu de');
  b.line('commandes (voir fiche).');
  b.line('1234567890'.repeat(Math.ceil(width / 10)).slice(0, width));
  b.line('^ derniere colonne = regle pleine');
  if (output.cutter) b.feed(4).cut();
  else b.feed(5);
  return b.build();
}

export function sampleTicket(overrides: Partial<TicketPayload> = {}): TicketPayload {
  return {
    version: 1,
    register_code: 'C01',
    ticket_number: 999999,
    ticket_code: 'T-2026-999999',
    duplicate: true,
    kind: 'sale',
    business_at: new Date().toISOString(),
    cashier_name: 'Recette',
    header: {
      company_name: 'Ma Papeterie',
      address_lines: ['10 rue Toupot de Béveaux', '52000 Chaumont'],
      siret: '000 000 000 00000',
      vat_number: 'FR00000000000',
      phone: '03 25 00 00 00',
    },
    lines: [
      {
        label: 'Cahier 96 pages grands carreaux Clairefontaine œuvre',
        qty: 2,
        unit_price_ttc_cents: 1250,
        discount_percent: 0,
        line_ttc_cents: 2500,
        vat_rate: '20.00',
      },
      {
        label: 'Stylo plume Lamy Safari',
        qty: 1,
        unit_price_ttc_cents: 2990,
        discount_percent: 10,
        line_ttc_cents: 2691,
        vat_rate: '20.00',
      },
      {
        label: 'Livre « Le Petit Prince »',
        qty: 1,
        unit_price_ttc_cents: 790,
        discount_percent: 0,
        line_ttc_cents: 790,
        vat_rate: '5.50',
      },
      {
        label: 'Imprimante multifonction (montant long)',
        qty: 1,
        unit_price_ttc_cents: 123_456,
        discount_percent: 0,
        line_ttc_cents: 123_456,
        vat_rate: '20.00',
      },
    ],
    vat_breakdown: [
      { rate: '5.50', base_ht_cents: 749, vat_cents: 41, ttc_cents: 790 },
      { rate: '20.00', base_ht_cents: 107_205, vat_cents: 21_442, ttc_cents: 128_647 },
    ],
    total_ht_cents: 107_954,
    total_vat_cents: 21_483,
    total_ttc_cents: 129_437,
    payments: [
      { method: 'cb', label: 'Carte bancaire', amount_cents: 120_000 },
      { method: 'cash', label: 'Espèces', amount_cents: 9_500 },
    ],
    change_cents: 63,
    footer: { lines: ['TICKET DE RECETTE', 'Sans valeur - test imprimante'] },
    compliance: {
      hash_short: '1a2b3c4d',
      signature_status: 'signed',
      fiskaly_signature_short: 'ABCDEF0123456789',
      software: 'Ma Papeterie POS',
      version: 'recette',
    },
    invoice_requested: false,
    ...overrides,
  };
}

export function sampleReport() {
  const now = new Date();
  const start = new Date(now.getTime() - 9 * 3600_000);
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
      header: sampleTicket().header,
      period_start: start.toISOString(),
      period_end: now.toISOString(),
      printed_at: now.toISOString(),
      app_version: 'recette',
      number: 999,
      session_number: 999,
      hash: 'a1b2c3d4e5f6a7b8c9d0',
      duplicate: true,
    },
  );
}

export function outputOf(config: BridgeConfig): OutputOptions {
  const p = config.printer;
  return {
    commandSet: p.commandSet,
    cutter: p.cutter,
    ...(p.codepageNumber !== undefined ? { codepageNumber: p.codepageNumber } : {}),
  };
}

/** Documents de chaque étape (hors `diag`, qui n'imprime rien). */
export function stepBuffers(step: Exclude<RecetteStep, 'diag'>, config: BridgeConfig): Buffer {
  const output = outputOf(config);
  const width = config.printer.width;
  switch (step) {
    case 'codepage':
      return codepagePage(output, width);
    case 'ticket':
      return renderTicket(sampleTicket(), width, output);
    case 'formation':
      return renderTicket(
        sampleTicket({
          ticket_number: null,
          ticket_code: 'FORM-0001',
          duplicate: false,
          compliance: {
            hash_short: '',
            signature_status: 'mock',
            software: 'Ma Papeterie POS',
            version: 'recette',
            training: true,
          },
        }),
        width,
        output,
      );
    case 'rapport':
      return renderReport(sampleReport(), width, output);
    case 'tiroir':
      return buildDrawerCommand(config.drawer.pin, output);
  }
}

const EXPECTED: Record<RecetteStep, string> = {
  diag: 'configuration lue, imprimante joignable',
  codepage:
    'une ligne numérotée lisible ; GRAS / DOUBLE / CENTRE / DROITE sans caractères parasites',
  ticket: 'accents et € corrects, montants complets (1 234,56 €), TVA 20 % et 5,5 %, DUPLICATA',
  formation: 'mention FORMATION en grand, « Formation : aucune empreinte », pas de signature',
  rapport:
    'CLÔTURE JOURNALIÈRE Z1, montants à 8 chiffres complets, grand total perpétuel sur 2 lignes si besoin',
  tiroir: 'le tiroir s’ouvre (rien ne s’imprime)',
};

function parseArgs(argv: string[]): {
  steps: RecetteStep[];
  out: string | null;
  config: string | null;
} {
  const steps: RecetteStep[] = [];
  let out: string | null = null;
  let config: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--out') out = argv[++i] ?? null;
    else if (a === '--config') config = argv[++i] ?? null;
    else if ((RECETTE_STEPS as readonly string[]).includes(a)) steps.push(a as RecetteStep);
    else throw new Error(`Argument inconnu : ${a} (étapes : ${RECETTE_STEPS.join(', ')})`);
  }
  return { steps: steps.length ? steps : [...RECETTE_STEPS], out, config };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.config) process.env.BRIDGE_CONFIG = args.config;
  const config = loadConfig();
  const printer = createPrinter(config.printer);
  const p = config.printer;
  let failures = 0;

  for (const step of args.steps) {
    if (step === 'diag') {
      console.log(`\n[diag] configuration : ${resolveConfigPath()}`);
      console.log(
        `       profil=${p.profile ?? '-'} type=${p.type} jeu=${p.commandSet} largeur=${p.width} ` +
          `massicot=${p.cutter} page=${p.codepageNumber ?? 'défaut'} ` +
          `cible=${p.type === 'network' ? `${p.host}:${p.port}` : (p.path ?? '-')} tiroir=${config.drawer.pin}`,
      );
      const ok = await printer.reachable();
      console.log(`       imprimante ${ok ? 'JOIGNABLE' : 'INJOIGNABLE'}`);
      if (!ok) failures += 1;
      continue;
    }
    const buffer = stepBuffers(step, config);
    if (args.out) {
      const dir = resolve(args.out);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `recette-${step}.bin`);
      writeFileSync(file, buffer);
      console.log(`\n[${step}] écrit : ${file} (${buffer.length} octets)`);
    } else {
      try {
        await printer.print(buffer);
        console.log(`\n[${step}] envoyé (${buffer.length} octets)`);
      } catch (error) {
        failures += 1;
        console.log(
          `\n[${step}] ÉCHEC : ${error instanceof PrinterError ? error.message : String(error)}`,
        );
        continue;
      }
    }
    console.log(`       attendu : ${EXPECTED[step]}`);
  }
  console.log(
    failures
      ? `\n${failures} échec(s).`
      : '\nTerminé. Reporter les constats sur la fiche docs/RECETTE-MPOP.md.',
  );
  process.exitCode = failures ? 1 : 0;
}

// Exécution directe uniquement (le module est aussi importé par les tests).
if (process.argv[1] && /recette\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 2;
  });
}
