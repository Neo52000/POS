/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_CATALOG_SUPABASE_URL?: string;
  readonly VITE_CATALOG_SUPABASE_ANON_KEY?: string;
  readonly VITE_BRIDGE_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_E2E_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** API `BarcodeDetector` (Chrome / Safari 17+), absente des lib DOM de TypeScript. */
interface DetectedBarcode {
  rawValue: string;
  format: string;
}

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  static getSupportedFormats(): Promise<string[]>;
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}
