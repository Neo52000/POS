import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/** Couleur pilotée par une variable CSS `--c-<nom>` (canaux RGB) : thèmes sombre et clair. */
const token = (name: string): string => `rgb(var(--c-${name}) / <alpha-value>)`;

/** Palette « Data Noir » (SPEC §10) et son pendant clair (SPEC §13.4), voir `index.css`. */
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        border: token('border'),
        text: token('text'),
        muted: token('muted'),
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          soft: 'rgb(var(--c-accent) / 0.1)',
        },
        success: token('success'),
        warning: token('warning'),
        danger: token('danger'),
        /** Texte posé sur un aplat accent / danger / succès. */
        'on-accent': token('on-accent'),
      },
      fontFamily: {
        sans: ['Poppins', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      minHeight: { touch: '56px', pay: '72px' },
      minWidth: { touch: '56px' },
      keyframes: {
        'slide-in-from-bottom': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'slide-out-to-bottom': {
          from: { transform: 'translateY(0)' },
          to: { transform: 'translateY(100%)' },
        },
      },
    },
  },
  plugins: [animate],
};

export default config;
