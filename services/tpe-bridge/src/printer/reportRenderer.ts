/**
 * Rendu papier d'un `ReportPayload` (SPEC §13) : lecture X, clôtures Z1 / Z2 / Z3.
 * Mise en page `libellé … valeur` ; une valeur trop longue passe sur sa propre ligne, alignée à
 * droite (jamais tronquée : un montant coupé serait faux).
 */
import { formatParisDateTime, type ReportPayload } from '@pos/core';
import { DEFAULT_OUTPUT, encodeLines, type OutputOptions, type RenderedLine } from './builder.js';
import { displayWidth } from './escpos.js';
import { center, columns, rule, truncate } from './ticketRenderer.js';

export function renderReportLines(payload: ReportPayload, width: number): RenderedLine[] {
  const lines: RenderedLine[] = [];
  const half = Math.floor(width / 2);
  const push = (text: string, style?: RenderedLine['style']): void => {
    lines.push(style ? { text, style } : { text });
  };

  push(center(payload.header.company_name, half), { align: 'center', bold: true, size: [2, 2] });
  for (const address of payload.header.address_lines)
    push(center(address, width), { align: 'center' });
  if (payload.header.siret)
    push(center(`SIRET ${payload.header.siret}`, width), { align: 'center' });
  push(rule(width, '='));
  push(center(payload.title, width), { align: 'center', bold: true, size: [1, 2] });
  if (payload.subtitle) push(center(payload.subtitle, width), { align: 'center' });
  if (payload.training) {
    push(center('FORMATION', half), { align: 'center', bold: true, size: [2, 2] });
    push(center('Sans valeur - non enregistré', width), { align: 'center', bold: true });
  }
  if (payload.duplicate)
    push(center('DUPLICATA', half), { align: 'center', bold: true, size: [2, 2] });
  push(rule(width, '='));

  for (const section of payload.sections) {
    if (section.title) push(truncate(section.title.toUpperCase(), width), { bold: true });
    for (const row of section.rows) {
      const style = row.bold ? { bold: true } : undefined;
      if (row.value === undefined) {
        push(truncate(row.label, width), style);
        continue;
      }
      if (displayWidth(row.label) + 1 + displayWidth(row.value) <= width) {
        push(columns(row.label, row.value, width), style);
      } else {
        push(truncate(row.label, width), style);
        const value = truncate(row.value, width);
        push(' '.repeat(Math.max(0, width - displayWidth(value))) + value, style);
      }
    }
    push(rule(width));
  }

  for (const footer of payload.footer) push(center(footer, width), { align: 'center' });
  push(center(`Édité le ${formatParisDateTime(payload.printed_at)}`, width), { align: 'center' });
  push(center(`${payload.software} v${payload.app_version}`, width), { align: 'center' });
  return lines;
}

export function renderReport(
  payload: ReportPayload,
  width: number,
  output: OutputOptions = DEFAULT_OUTPUT,
): Buffer {
  return encodeLines(renderReportLines(payload, width), output);
}
