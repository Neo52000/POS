/**
 * Builder Star Line Mode / StarPRNT (Star Micronics : mPOP, mC-Print, TSP100/143/650…).
 *
 * Les imprimantes Star de la gamme mPOP (POP10) ne comprennent pas l'ESC/POS Epson : mêmes
 * octets ESC, sémantique différente (ex. `ESC a` Epson = alignement, `ESC a n` Star = avance de
 * n lignes). Commandes utilisées, communes à Star Line Mode et StarPRNT :
 *
 * - init `ESC @` (1B 40) ; page de codes `ESC GS t n` (1B 1D 74 n), CP858 = 4 ;
 * - alignement `ESC GS a n` (1B 1D 61 n) ; gras `ESC E` (1B 45) / `ESC F` (1B 46) ;
 * - agrandissement `ESC i n1 n2` (1B 69 hauteur largeur, 0 = normal) ; saut `LF` (0A) ;
 * - coupe partielle après avance `ESC d 3` (1B 64 03) — ignorée sans massicot (mPOP : barre de
 *   découpe manuelle) ;
 * - tiroir : `BEL` (07) = périphérique 1, `SUB` (1A) = périphérique 2 (mPOP : tiroir intégré sur
 *   le périphérique 1).
 */
import { encodeCp858 } from './escpos.js';
import type { Alignment, PrinterCommands } from './builder.js';

export const STAR_ESC = 0x1b;
export const STAR_GS = 0x1d;
export const STAR_LF = 0x0a;
export const STAR_BEL = 0x07;
export const STAR_SUB = 0x1a;

/** Numéro de la page de codes CP858 pour `ESC GS t n` (table Star). */
export const STAR_CODEPAGE_CP858 = 4;

const ALIGNMENTS: Record<Alignment, number> = { left: 0, center: 1, right: 2 };

export class StarLineBuilder implements PrinterCommands {
  private readonly chunks: Buffer[] = [];

  constructor(private readonly codepageNumber: number = STAR_CODEPAGE_CP858) {}

  /** `ESC @` + page de codes. */
  init(): this {
    return this.raw(STAR_ESC, 0x40).raw(STAR_ESC, STAR_GS, 0x74, this.codepageNumber);
  }

  raw(...bytes: number[]): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  append(buffer: Buffer): this {
    this.chunks.push(buffer);
    return this;
  }

  /** `ESC GS a n`. */
  align(alignment: Alignment): this {
    return this.raw(STAR_ESC, STAR_GS, 0x61, ALIGNMENTS[alignment]);
  }

  /** `ESC E` / `ESC F`. */
  bold(on: boolean): this {
    return this.raw(STAR_ESC, on ? 0x45 : 0x46);
  }

  /** `ESC i n1 n2` : hauteur puis largeur, multiplicateurs 1 à 6. */
  size(width = 1, height = 1): this {
    const w = Math.min(6, Math.max(1, width)) - 1;
    const h = Math.min(6, Math.max(1, height)) - 1;
    return this.raw(STAR_ESC, 0x69, h, w);
  }

  text(text: string): this {
    return this.append(encodeCp858(text));
  }

  line(text = ''): this {
    return this.text(text).raw(STAR_LF);
  }

  feed(n = 1): this {
    for (let i = 0; i < n; i += 1) this.raw(STAR_LF);
    return this;
  }

  /** `ESC d 3` : avance jusqu'à la lame puis coupe partielle. */
  cut(): this {
    return this.raw(STAR_ESC, 0x64, 0x03);
  }

  /** `BEL` (périphérique 1) ou `SUB` (périphérique 2). */
  drawer(pin: 0 | 1 = 0): this {
    return this.raw(pin === 0 ? STAR_BEL : STAR_SUB);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
