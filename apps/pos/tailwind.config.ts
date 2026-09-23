import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/** Palette « Data Noir » (SPEC §10). */
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f',
        surface: '#111118',
        border: '#1e1e2e',
        text: '#e2e8f0',
        muted: '#64748b',
        accent: { DEFAULT: '#6366f1', hover: '#4f52d9', soft: '#6366f11a' },
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
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
