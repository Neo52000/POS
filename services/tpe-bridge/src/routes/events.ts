import type { FastifyInstance } from 'fastify';
import type { BridgeContext } from './context.js';

/** `WS /events` : diffusion des phases de paiement. Le jeton est vérifié par le hook global. */
export function registerEventRoutes(app: FastifyInstance, ctx: BridgeContext): void {
  app.get('/events', { websocket: true }, (socket, request) => {
    const remove = ctx.events.add(socket);
    ctx.log.info({ ip: request.ip, clients: ctx.events.size }, 'ws: client connecté');
    socket.send(JSON.stringify({ type: 'hello', version: ctx.version, busy: ctx.payments.busy }));
    socket.on('close', () => {
      remove();
      ctx.log.info({ clients: ctx.events.size }, 'ws: client déconnecté');
    });
    socket.on('error', () => remove());
  });
}
