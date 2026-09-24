/**
 * Configuration du pont TPE (`bridge.config.json`, SPEC §8).
 *
 * Chargement : `BRIDGE_CONFIG` (chemin) ou `./bridge.config.json` (répertoire courant).
 * Défauts sûrs : écoute locale uniquement (127.0.0.1:8787), TPE réel désactivé tant que
 * `tpe.simulate` est `false` et qu'aucun hôte n'est fourni, imprimante `none`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const port = z.number().int().min(1).max(65535);

export const HttpConfigSchema = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: port.default(8787),
  })
  .strict();

/**
 * TLS natif (iPad / Safari : la PWA HTTPS ne peut joindre qu'un pont HTTPS). Certificat et clé
 * PEM lus au démarrage ; ex. Let's Encrypt DNS-01 pour `bridge.ma-papeterie.fr`.
 */
export const TlsConfigSchema = z
  .object({
    /** Chaîne de certificats PEM (`fullchain.pem`). */
    certPath: z.string().min(1),
    /** Clé privée PEM (`privkey.pem`), lisible uniquement par le compte du service. */
    keyPath: z.string().min(1),
  })
  .strict();

export const TpeConfigSchema = z
  .object({
    /** Adresse IP fixe du TPE (Caisse-AP over IP). */
    host: z.string().min(1).default('127.0.0.1'),
    port: port.default(8888),
    /** Numéro de caisse (tag `CA`), 2 caractères. */
    posNumber: z
      .string()
      .regex(/^\d{2}$/, 'posNumber : 2 chiffres')
      .default('01'),
    /** Délai maximal d'attente de la réponse du TPE (saisie du code par le client incluse). */
    timeoutMs: z.number().int().min(1000).max(600_000).default(90_000),
    /** Délai de connexion TCP. */
    connectTimeoutMs: z.number().int().min(200).max(60_000).default(5_000),
    /** Devise ISO 4217 numérique (tag `CE`). */
    currency: z
      .string()
      .regex(/^\d{3}$/, 'currency : code ISO 4217 à 3 chiffres')
      .default('978'),
    /** Identifiant protocole (tag `CJ`). */
    protocolId: z
      .string()
      .regex(/^\d{3}$/, 'protocolId : 3 chiffres')
      .default('012'),
    /** Version protocole (tag `CZ`). */
    protocolVersion: z
      .string()
      .regex(/^\d{4}$/, 'protocolVersion : 4 chiffres')
      .default('0300'),
    /** `true` : simulateur intégré (aucun TPE réel contacté). */
    simulate: z.boolean().default(false),
  })
  .strict();

export const PrinterConfigSchema = z
  .object({
    type: z.enum(['network', 'none']).default('none'),
    host: z.string().min(1).optional(),
    port: port.default(9100),
    timeoutMs: z.number().int().min(200).max(60_000).default(5_000),
    codepage: z.literal('CP858').default('CP858'),
    /** Largeur en caractères (police A, 80 mm → 42 ou 48 selon l'imprimante). */
    width: z.number().int().min(24).max(64).default(42),
  })
  .strict()
  .superRefine((printer, ctx) => {
    if (printer.type === 'network' && !printer.host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['host'],
        message: 'printer.host est requis quand printer.type = "network"',
      });
    }
  });

export const DrawerConfigSchema = z
  .object({
    /** Broche du tiroir sur l'imprimante (`ESC p m`) : 0 ou 1. */
    pin: z.union([z.literal(0), z.literal(1)]).default(0),
  })
  .strict();

export const BridgeConfigSchema = z
  .object({
    http: HttpConfigSchema.default({}),
    /** Jeton partagé avec la PWA (`X-Bridge-Token`). */
    token: z.string().min(16, 'token : 16 caractères minimum'),
    /** Origines autorisées (CORS). Vide = aucune origine navigateur autorisée. */
    allowedOrigins: z.array(z.string().url()).default([]),
    tpe: TpeConfigSchema.default({}),
    printer: PrinterConfigSchema.default({}),
    drawer: DrawerConfigSchema.default({}),
    /** Absent : HTTP simple (PC comptoir, `127.0.0.1`). Présent : HTTPS natif Fastify. */
    tls: TlsConfigSchema.optional(),
  })
  .strict();

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;
export type BridgeConfigInput = z.input<typeof BridgeConfigSchema>;
export type TpeConfig = BridgeConfig['tpe'];
export type PrinterConfig = BridgeConfig['printer'];
export type TlsConfig = z.infer<typeof TlsConfigSchema>;

export const DEFAULT_CONFIG_FILE = './bridge.config.json';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    message: string,
    readonly path: string,
    readonly issues: z.ZodIssue[] = [],
  ) {
    super(message);
  }
}

/**
 * JSON n'a pas de commentaires : les clés de premier niveau commençant par `//` sont ignorées
 * (ex. `"//tls": {…}` dans l'exemple — renommer en `"tls"` pour l'activer).
 */
function stripCommentKeys(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith('//')));
}

/** Valide un objet déjà parsé (utile pour les tests et l'index). */
export function parseConfig(input: unknown, source = '<inline>'): BridgeConfig {
  const result = BridgeConfigSchema.safeParse(stripCommentKeys(input));
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<racine>'} : ${issue.message}`)
      .join('\n');
    throw new ConfigError(
      `Configuration invalide (${source}) :\n${detail}`,
      source,
      result.error.issues,
    );
  }
  return result.data;
}

/** Chemin effectif du fichier de configuration. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(process.cwd(), env.BRIDGE_CONFIG || DEFAULT_CONFIG_FILE);
}

/**
 * Charge `bridge.config.json`. `BRIDGE_TOKEN` (env) remplace `token` si défini, ce qui permet
 * de ne pas écrire le jeton dans le fichier sur un poste partagé.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const path = resolveConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Fichier de configuration introuvable ou illisible : ${path} (${reason}). ` +
        `Copiez bridge.config.example.json vers bridge.config.json ou définissez BRIDGE_CONFIG.`,
      path,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`JSON invalide dans ${path} : ${reason}`, path);
  }
  if (env.BRIDGE_TOKEN && json !== null && typeof json === 'object' && !Array.isArray(json)) {
    json = { ...(json as Record<string, unknown>), token: env.BRIDGE_TOKEN };
  }
  return parseConfig(json, path);
}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

/**
 * Lit le certificat et la clé TLS. Les chemins relatifs sont résolus depuis le répertoire du
 * fichier de configuration (`baseDir`), sinon depuis le répertoire courant.
 */
export function loadTlsMaterial(tls: TlsConfig, baseDir: string = process.cwd()): TlsMaterial {
  const read = (label: string, file: string): Buffer => {
    const path = resolve(baseDir, file);
    try {
      return readFileSync(path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`tls.${label} illisible : ${path} (${reason})`, path);
    }
  };
  return { cert: read('certPath', tls.certPath), key: read('keyPath', tls.keyPath) };
}
