/**
 * Rendu ESC/POS d'un `TicketPayload` (SPEC §6) pour une imprimante 80 mm (42 colonnes par défaut).
 *
 * `renderTicketLines()` produit la mise en page texte (testable), `renderTicket()` l'encode
 * avec les attributs ESC/POS (gras, taille, alignement) et termine par avance papier + coupe.
 */
import { formatEurCents, SOFTWARE_NAME, type TicketLine, type TicketPayload } from '@pos/core';
import { displayWidth, EscPosBuilder } from './escpos.js';

export const DEFAULT_TICKET_WIDTH = 42;

export type RenderedStyle = {
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  /** `[largeur, hauteur]` (1 = normal). Une largeur 2 divise le nombre de colonnes par deux. */
  size?: [number, number];
};

export interface RenderedLine {
  text: string;
  style?: RenderedStyle;
}

const money = (cents: number): string => formatEurCents(cents);

/** Tronque `text` à `width` colonnes (largeur CP858). */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  for (const char of text) {
    if (displayWidth(out + char) > width) break;
    out += char;
  }
  return out;
}

/** `left` à gauche, `right` à droite, complété par des espaces ; `left` tronqué si nécessaire. */
export function columns(left: string, right: string, width: number): string {
  const rightWidth = displayWidth(right);
  const available = Math.max(0, width - rightWidth - 1);
  const leftText = truncate(left, available);
  const gap = Math.max(1, width - displayWidth(leftText) - rightWidth);
  return leftText + ' '.repeat(gap) + right;
}

export function center(text: string, width: number): string {
  const t = truncate(text, width);
  const pad = Math.max(0, Math.floor((width - displayWidth(t)) / 2));
  return ' '.repeat(pad) + t;
}

export function rule(width: number, char = '-'): string {
  return char.repeat(width);
}

/** `2` → `2`, `2.5` → `2,5`, `-1` → `-1`. */
export function formatQty(qty: number): string {
  return String(Number(qty.toFixed(3))).replace('.', ',');
}

export function formatPercent(percent: number): string {
  return `${percent.toFixed(2).replace('.', ',')} %`;
}

export function formatBusinessAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(',', '');
}

function renderLine(line: TicketLine, width: number): RenderedLine[] {
  const out: RenderedLine[] = [{ text: truncate(line.label, width) }];
  const detail = `  ${formatQty(line.qty)} x ${money(line.unit_price_ttc_cents)}`;
  out.push({ text: columns(detail, money(line.line_ttc_cents), width) });
  if (line.discount_percent > 0) {
    out.push({ text: truncate(`  dont remise ${formatPercent(line.discount_percent)}`, width) });
  }
  if (line.price_tier_title) {
    const publicPrice =
      line.public_price_ttc_cents !== undefined && line.public_price_ttc_cents !== null
        ? ` (prix public ${money(line.public_price_ttc_cents)})`
        : '';
    out.push({ text: truncate(`  Tarif ${line.price_tier_title}${publicPrice}`, width) });
  }
  return out;
}

/** `Signature <…>` si signée (ou mock), sinon « Signature électronique en attente ». */
function signatureLine(payload: TicketPayload): string {
  const { compliance } = payload;
  const signed = compliance.signature_status === 'signed' || compliance.signature_status === 'mock';
  if (signed && compliance.fiskaly_signature_short) {
    return `Signature ${compliance.fiskaly_signature_short}`;
  }
  return 'Signature électronique en attente';
}

/** Tableau à colonnes fixes : `[texte, largeur, alignement]`, cellules tronquées si trop longues. */
export function row(cells: Array<[text: string, width: number, align: 'left' | 'right']>): string {
  return cells
    .map(([text, width, align]) => {
      const t = truncate(text, width);
      const pad = ' '.repeat(Math.max(0, width - displayWidth(t)));
      return align === 'right' ? pad + t : t + pad;
    })
    .join('');
}

/** Largeurs des colonnes du tableau TVA pour `width` colonnes (taux, base HT, TVA, TTC). */
function vatColumns(width: number): [number, number, number, number] {
  const amount = Math.floor((width - 8) / 3);
  const rest = width - 8 - amount * 3;
  return [8, amount, amount, amount + rest];
}

/** Mise en page texte du ticket (chaque ligne ≤ `width` colonnes une fois encodée). */
export function renderTicketLines(
  payload: TicketPayload,
  width: number = DEFAULT_TICKET_WIDTH,
): RenderedLine[] {
  const lines: RenderedLine[] = [];
  const half = Math.floor(width / 2);
  const push = (text: string, style?: RenderedStyle): void => {
    lines.push(style ? { text, style } : { text });
  };

  // En-tête
  push(center(payload.header.company_name, half), { align: 'center', bold: true, size: [2, 2] });
  for (const address of payload.header.address_lines)
    push(center(address, width), { align: 'center' });
  if (payload.header.phone)
    push(center(`Tél. ${payload.header.phone}`, width), { align: 'center' });
  push(center(`SIRET ${payload.header.siret}`, width), { align: 'center' });
  push(center(`TVA ${payload.header.vat_number}`, width), { align: 'center' });
  push(rule(width));

  // Mentions spéciales
  if (payload.duplicate) {
    push(center('DUPLICATA', half), { align: 'center', bold: true, size: [2, 2] });
  }
  if (payload.compliance.provisional) {
    push(center('TICKET PROVISOIRE', width), { align: 'center', bold: true });
    push(center('signature différée', width), { align: 'center', bold: true });
  }
  if (payload.kind === 'refund') {
    push(center('REMBOURSEMENT', width), { align: 'center', bold: true });
    if (payload.refund_of_ticket_code) {
      push(center(`sur ticket ${payload.refund_of_ticket_code}`, width), { align: 'center' });
    }
  }

  // Identification
  push(columns(`Ticket ${payload.ticket_code}`, `Caisse ${payload.register_code}`, width));
  push(columns(formatBusinessAt(payload.business_at), `Vendeur ${payload.cashier_name}`, width));
  if (payload.quote_number) push(truncate(`Devis ${payload.quote_number}`, width));
  if (payload.invoice_requested) push(truncate('Facture demandée', width));

  // Client
  if (payload.customer) {
    push(rule(width));
    push(truncate(`Client : ${payload.customer.display_name}`, width));
    if (payload.customer.company_name) push(truncate(payload.customer.company_name, width));
    if (payload.customer.siret) push(truncate(`SIRET ${payload.customer.siret}`, width));
    if (payload.customer.vat_number) push(truncate(`TVA ${payload.customer.vat_number}`, width));
  }
  push(rule(width));

  // Lignes
  for (const line of payload.lines) lines.push(...renderLine(line, width));
  push(rule(width));

  // Totaux
  push(columns('Total HT', money(payload.total_ht_cents), width));
  push(columns('Total TVA', money(payload.total_vat_cents), width));
  push(columns('TOTAL TTC', money(payload.total_ttc_cents), width), { bold: true, size: [1, 2] });
  push(rule(width));

  // Ventilation TVA
  const [wRate, wBase, wVat, wTtc] = vatColumns(width);
  push(
    row([
      ['Taux', wRate, 'left'],
      ['Base HT', wBase, 'right'],
      ['TVA', wVat, 'right'],
      ['TTC', wTtc, 'right'],
    ]),
  );
  for (const entry of payload.vat_breakdown) {
    push(
      row([
        [`${entry.rate.replace('.', ',')} %`, wRate, 'left'],
        [money(entry.base_ht_cents), wBase, 'right'],
        [money(entry.vat_cents), wVat, 'right'],
        [money(entry.ttc_cents), wTtc, 'right'],
      ]),
    );
  }
  push(rule(width));

  // Paiements
  for (const payment of payload.payments) {
    push(columns(payment.label, money(payment.amount_cents), width));
    if (payment.reference) push(truncate(`  Réf. ${payment.reference}`, width));
  }
  if (payload.change_cents > 0) push(columns('Rendu', money(payload.change_cents), width));
  push(rule(width));

  // Pied de page
  for (const footer of payload.footer.lines) push(center(footer, width), { align: 'center' });
  if (payload.footer.lines.length > 0) push('');

  // Conformité
  push(center(`Ticket ${payload.ticket_code}`, width), { align: 'center' });
  push(center(`Hash ${payload.compliance.hash_short}`, width), { align: 'center' });
  push(center(signatureLine(payload), width), { align: 'center' });
  if (payload.compliance.provisional) {
    push(center('TICKET PROVISOIRE - signature différée', width), { align: 'center' });
  }
  if (payload.duplicate) push(center('DUPLICATA', width), { align: 'center', bold: true });
  push(
    center(`${payload.compliance.software || SOFTWARE_NAME} v${payload.compliance.version}`, width),
    {
      align: 'center',
    },
  );

  return lines;
}

/** Ticket complet en ESC/POS : init, lignes stylées, avance papier, coupe. */
export function renderTicket(payload: TicketPayload, width: number = DEFAULT_TICKET_WIDTH): Buffer {
  const builder = new EscPosBuilder().init();
  let align: RenderedStyle['align'] = 'left';
  let bold = false;
  let size: [number, number] = [1, 1];
  for (const line of renderTicketLines(payload, width)) {
    const style = line.style ?? {};
    const wantAlign = style.align ?? 'left';
    const wantBold = style.bold ?? false;
    const wantSize = style.size ?? [1, 1];
    if (wantAlign !== align) {
      builder.align(wantAlign);
      align = wantAlign;
    }
    if (wantBold !== bold) {
      builder.bold(wantBold);
      bold = wantBold;
    }
    if (wantSize[0] !== size[0] || wantSize[1] !== size[1]) {
      builder.size(wantSize[0], wantSize[1]);
      size = wantSize;
    }
    // Les lignes centrées via ESC a n n'ont pas besoin du padding gauche.
    builder.line(wantAlign === 'center' ? line.text.trimStart() : line.text);
  }
  if (bold) builder.bold(false);
  if (size[0] !== 1 || size[1] !== 1) builder.size(1, 1);
  builder.align('left').feed(4).cut();
  return builder.build();
}
