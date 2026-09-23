/**
 * Builder ESC/POS minimal (Epson-compatible) avec encodage CP858 maison.
 *
 * Commandes : init `ESC @` (1B 40), alignement `ESC a n` (1B 61 n), gras `ESC E n` (1B 45 n),
 * taille `GS ! n` (1D 21 n), page de codes CP858 `ESC t 19` (1B 74 13), saut `LF` (0A),
 * coupe partielle `GS V 66 0` (1D 56 42 00), tiroir `ESC p m 25 250` (1B 70 m 19 FA).
 */

export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;

/** Numéro de page de codes CP858 pour `ESC t n` (Epson : 19). */
export const CODEPAGE_CP858 = 19;

export type Alignment = 'left' | 'center' | 'right';

const ALIGNMENTS: Record<Alignment, number> = { left: 0, center: 1, right: 2 };

/** Caractères non ASCII → octet CP858 (zone haute de CP850 + `€` en 0xD5). */
export const CP858_TABLE: ReadonlyMap<string, number> = new Map<string, number>([
  ['Ç', 0x80],
  ['ü', 0x81],
  ['é', 0x82],
  ['â', 0x83],
  ['ä', 0x84],
  ['à', 0x85],
  ['å', 0x86],
  ['ç', 0x87],
  ['ê', 0x88],
  ['ë', 0x89],
  ['è', 0x8a],
  ['ï', 0x8b],
  ['î', 0x8c],
  ['ì', 0x8d],
  ['Ä', 0x8e],
  ['Å', 0x8f],
  ['É', 0x90],
  ['æ', 0x91],
  ['Æ', 0x92],
  ['ô', 0x93],
  ['ö', 0x94],
  ['ò', 0x95],
  ['û', 0x96],
  ['ù', 0x97],
  ['ÿ', 0x98],
  ['Ö', 0x99],
  ['Ü', 0x9a],
  ['ø', 0x9b],
  ['£', 0x9c],
  ['Ø', 0x9d],
  ['×', 0x9e],
  ['ƒ', 0x9f],
  ['á', 0xa0],
  ['í', 0xa1],
  ['ó', 0xa2],
  ['ú', 0xa3],
  ['ñ', 0xa4],
  ['Ñ', 0xa5],
  ['ª', 0xa6],
  ['º', 0xa7],
  ['¿', 0xa8],
  ['®', 0xa9],
  ['¬', 0xaa],
  ['½', 0xab],
  ['¼', 0xac],
  ['¡', 0xad],
  ['«', 0xae],
  ['»', 0xaf],
  ['Á', 0xb5],
  ['Â', 0xb6],
  ['À', 0xb7],
  ['©', 0xb8],
  ['¢', 0xbd],
  ['¥', 0xbe],
  ['ã', 0xc6],
  ['Ã', 0xc7],
  ['¤', 0xcf],
  ['ð', 0xd0],
  ['Ð', 0xd1],
  ['Ê', 0xd2],
  ['Ë', 0xd3],
  ['È', 0xd4],
  ['€', 0xd5],
  ['Í', 0xd6],
  ['Î', 0xd7],
  ['Ï', 0xd8],
  ['¦', 0xdd],
  ['Ì', 0xde],
  ['Ó', 0xe0],
  ['ß', 0xe1],
  ['Ô', 0xe2],
  ['Ò', 0xe3],
  ['õ', 0xe4],
  ['Õ', 0xe5],
  ['µ', 0xe6],
  ['þ', 0xe7],
  ['Þ', 0xe8],
  ['Ú', 0xe9],
  ['Û', 0xea],
  ['Ù', 0xeb],
  ['ý', 0xec],
  ['Ý', 0xed],
  ['¯', 0xee],
  ['´', 0xef],
  ['±', 0xf1],
  ['¾', 0xf3],
  ['¶', 0xf4],
  ['§', 0xf5],
  ['÷', 0xf6],
  ['¸', 0xf7],
  ['°', 0xf8],
  ['¨', 0xf9],
  ['·', 0xfa],
  ['¹', 0xfb],
  ['³', 0xfc],
  ['²', 0xfd],
]);

/** Caractères sans équivalent CP858 remplacés par une séquence ASCII. */
export const CP858_FALLBACKS: ReadonlyMap<string, string> = new Map<string, string>([
  ['œ', 'oe'],
  ['Œ', 'OE'],
  [' ', ' '],
  [' ', ' '],
  [' ', ' '],
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['–', '-'],
  ['—', '-'],
  ['…', '...'],
  ['•', '*'],
]);

/**
 * Encode une chaîne en CP858. Les caractères de contrôle (sauf `\n`, `\t`) et les caractères
 * inconnus deviennent `?`. `\n` est conservé (LF).
 */
export function encodeCp858(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (char === '\n' || char === '\t') {
      bytes.push(code);
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
      continue;
    }
    const mapped = CP858_TABLE.get(char);
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    const fallback = CP858_FALLBACKS.get(char);
    if (fallback !== undefined) {
      for (const c of fallback) bytes.push(c.charCodeAt(0));
      continue;
    }
    bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

/** Largeur d'affichage d'une chaîne une fois encodée (les fallbacks `œ`→`oe` comptent 2). */
export function displayWidth(text: string): number {
  return encodeCp858(text).length;
}

export class EscPosBuilder {
  private readonly chunks: Buffer[] = [];

  /** `ESC @` + page de codes CP858. */
  init(): this {
    this.raw(ESC, 0x40);
    return this.codepage(CODEPAGE_CP858);
  }

  raw(...bytes: number[]): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  append(buffer: Buffer): this {
    this.chunks.push(buffer);
    return this;
  }

  /** `ESC t n`. */
  codepage(n: number = CODEPAGE_CP858): this {
    return this.raw(ESC, 0x74, n);
  }

  /** `ESC a n`. */
  align(alignment: Alignment): this {
    return this.raw(ESC, 0x61, ALIGNMENTS[alignment]);
  }

  /** `ESC E n`. */
  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** `GS ! n` : `width`/`height` de 1 à 8. */
  size(width = 1, height = 1): this {
    const w = Math.min(8, Math.max(1, width)) - 1;
    const h = Math.min(8, Math.max(1, height)) - 1;
    return this.raw(GS, 0x21, (w << 4) | h);
  }

  /** Texte encodé CP858, sans saut de ligne. */
  text(text: string): this {
    return this.append(encodeCp858(text));
  }

  /** Texte + `LF`. */
  line(text = ''): this {
    return this.text(text).raw(LF);
  }

  /** `n` sauts de ligne. */
  feed(n = 1): this {
    for (let i = 0; i < n; i += 1) this.raw(LF);
    return this;
  }

  /** `GS V 66 0` : coupe partielle après avance papier. */
  cut(): this {
    return this.raw(GS, 0x56, 0x42, 0x00);
  }

  /** `ESC p m 25 250` : impulsion tiroir (`pin` 0 ou 1, 50 ms / 500 ms). */
  drawer(pin: 0 | 1 = 0): this {
    return this.raw(ESC, 0x70, pin, 0x19, 0xfa);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Séquence autonome d'ouverture du tiroir (init + impulsion). */
export function buildDrawerPulse(pin: 0 | 1 = 0): Buffer {
  return new EscPosBuilder().raw(ESC, 0x40).drawer(pin).build();
}
