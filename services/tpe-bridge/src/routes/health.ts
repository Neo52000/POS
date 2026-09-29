import type { FastifyInstance } from 'fastify';
import type { PrinterType } from '../printer/transport.js';
import type { BridgeContext } from './context.js';

export interface HealthResponse {
  ok: boolean;
  version: string;
  tpe: { host: string; port: number; reachable: boolean };
  printer: {
    type: PrinterType;
    reachable: boolean;
    /** Jeu de commandes et largeur : la PWA adapte son aperçu (58 mm = 32 colonnes). */
    command_set: 'escpos' | 'star';
    width: number;
  };
  simulate: boolean;
  busy: boolean;
}

export function registerHealthRoutes(app: FastifyInstance, ctx: BridgeContext): void {
  app.get('/health', async (): Promise<HealthResponse> => {
    const [tpeReachable, printerReachable] = await Promise.all([
      ctx.tpeClient.reachable(),
      ctx.printer.reachable(),
    ]);
    return {
      ok: true,
      version: ctx.version,
      tpe: { host: ctx.tpeEndpoint.host, port: ctx.tpeEndpoint.port, reachable: tpeReachable },
      printer: {
        type: ctx.printer.type,
        reachable: printerReachable,
        command_set: ctx.config.printer.commandSet,
        width: ctx.config.printer.width,
      },
      simulate: ctx.config.tpe.simulate,
      busy: ctx.payments.busy,
    };
  });
}
