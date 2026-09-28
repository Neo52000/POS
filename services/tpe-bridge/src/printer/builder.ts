/**
 * Abstraction des jeux de commandes d'imprimante : ESC/POS (Epson et compatibles) ou Star
 * (mPOP, mC-Print…). Les renderers (ticket, rapport) produisent des lignes stylées ; `encodeLines`
 * les traduit dans le jeu de commandes de l'imprimante configurée.
 */
import { EscPosBuilder } from './escpos.js';
import { StarLineBuilder, STAR_CODEPAGE_CP858 } from './starline.js';

export type Alignment = 'left' | 'center' | 'right';
export type CommandSet = 'escpos' | 'star';

export interface PrinterCommands {
  init(): this;
  raw(...bytes: number[]): this;
  align(alignment: Alignment): this;
  bold(on: boolean): this;
  size(width?: number, height?: number): this;
  text(text: string): this;
  line(text?: string): this;
  feed(n?: number): this;
  cut(): this;
  drawer(pin?: 0 | 1): this;
  build(): Buffer;
}

/** Options de sortie papier propres au modèle d'imprimante. */
export interface OutputOptions {
  commandSet: CommandSet;
  /** Massicot présent : coupe partielle en fin de document. Sinon avance pour la barre de découpe. */
  cutter: boolean;
  /** Page de codes (numéro propre au jeu de commandes) ; défaut CP858. */
  codepageNumber?: number;
}

export const DEFAULT_OUTPUT: OutputOptions = { commandSet: 'escpos', cutter: true };

export function createCommands(
  options: Pick<OutputOptions, 'commandSet' | 'codepageNumber'>,
): PrinterCommands {
  if (options.commandSet === 'star') {
    return new StarLineBuilder(options.codepageNumber ?? STAR_CODEPAGE_CP858);
  }
  return new EscPosBuilder(options.codepageNumber);
}

export type RenderedStyle = {
  align?: Alignment;
  bold?: boolean;
  /** `[largeur, hauteur]` (1 = normal). Une largeur 2 divise le nombre de colonnes par deux. */
  size?: [number, number];
};

export interface RenderedLine {
  text: string;
  style?: RenderedStyle;
}

/** Encode des lignes stylées : init, attributs minimaux (changements seulement), fin de papier. */
export function encodeLines(lines: RenderedLine[], output: OutputOptions = DEFAULT_OUTPUT): Buffer {
  const builder = createCommands(output).init();
  let align: Alignment = 'left';
  let bold = false;
  let size: [number, number] = [1, 1];
  for (const line of lines) {
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
    // Les lignes centrées par la commande d'alignement n'ont pas besoin du padding gauche.
    builder.line(wantAlign === 'center' ? line.text.trimStart() : line.text);
  }
  if (bold) builder.bold(false);
  if (size[0] !== 1 || size[1] !== 1) builder.size(1, 1);
  builder.align('left');
  // Sans massicot (mPOP), 5 lignes amènent la dernière ligne imprimée au-delà de la barre de découpe.
  if (output.cutter) builder.feed(4).cut();
  else builder.feed(5);
  return builder.build();
}

/** Impulsion tiroir autonome (init + commande tiroir du jeu de commandes). */
export function buildDrawerCommand(
  pin: 0 | 1,
  options: Pick<OutputOptions, 'commandSet'> = DEFAULT_OUTPUT,
): Buffer {
  // ESC @ seul (sans page de codes) : séquence historique conservée pour ESC/POS.
  const builder = createCommands({ commandSet: options.commandSet });
  return builder.raw(0x1b, 0x40).drawer(pin).build();
}
