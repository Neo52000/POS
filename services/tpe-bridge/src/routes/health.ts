import type { FastifyInstance } from 'fastify';
import type { BridgeContext } from './context.js';

export interface HealthResponse {
  ok: boolean;
  version: string;
  tpe: { host: string; port: number; reachable: boolean };
  printer: { type: 'network' | 'none'; reachable: boolean };
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
      printer: { type: ctx.printer.type, reachable: printerReachable },
      simulate: ctx.config.tpe.simulate,
      busy: ctx.payments.busy,
    };
  });
}
