import { formatEurCents, parseEuroToCents } from '@pos/core';

export { formatEurCents, parseEuroToCents };

const TZ = 'Europe/Paris';

const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
});

const dateFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const isoDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toDate(value: string | Date | number): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `23/09/2026 14:05` (Europe/Paris). */
export function formatDateTime(value: string | Date | number): string {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : '';
}

/** `14:05` (Europe/Paris). */
export function formatTime(value: string | Date | number): string {
  const d = toDate(value);
  return d ? timeFmt.format(d) : '';
}

/** `mercredi 23 septembre 2026`. */
export function formatLongDate(value: string | Date | number): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : '';
}

/** `2026-09-23` en fuseau métier (business_date). */
export function businessDate(value: string | Date | number = new Date()): string {
  const d = toDate(value);
  return d ? isoDateFmt.format(d) : '';
}

/** Durée écoulée lisible : `2 h 05`, `12 min`. */
export function formatElapsed(since: string | Date | number, now: Date = new Date()): string {
  const d = toDate(since);
  if (!d) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

/** Quantité canonique : `1`, `2.5`, `-1`. */
export function formatQty(qty: number): string {
  return Number(qty.toFixed(3)).toString().replace('.', ',');
}

/** `20.00` → `20 %`, `5.50` → `5,5 %`. */
export function formatVatRate(rate: number | string): string {
  const n = typeof rate === 'number' ? rate : Number(rate);
  if (!Number.isFinite(n)) return String(rate);
  return `${Number(n.toFixed(2)).toString().replace('.', ',')} %`;
}

/** Remise : `10 %`, `12,5 %`. */
export function formatPercent(value: number): string {
  return `${Number(value.toFixed(2)).toString().replace('.', ',')} %`;
}
