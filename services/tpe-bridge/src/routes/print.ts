import type { FastifyInstance } from 'fastify';
import { renderTicket } from '../printer/ticketRenderer.js';
import { buildDrawerPulse } from '../printer/escpos.js';
import { PrinterError } from '../printer/transport.js';
import { DrawerOpenBodySchema, PrintRawBodySchema, TicketPayloadSchema } from '../schemas.js';
import { errorBody, type BridgeContext } from './context.js';

export function registerPrintRoutes(app: FastifyInstance, ctx: BridgeContext): void {
  const send = async (buffer: Buffer): Promise<{ ok: true } | { code: number; body: unknown }> => {
    try {
      await ctx.printer.print(buffer);
      return { ok: true };
    } catch (error) {
      if (error instanceof PrinterError) {
        ctx.log.warn({ code: error.code }, error.message);
        return {
          code: 503,
          body: { ok: false, ...errorBody('PRINTER_UNREACHABLE', error.message) },
        };
      }
      throw error;
    }
  };

  app.post('/print', async (request, reply) => {
    const parsed = TicketPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION', 'TicketPayload invalide', parsed.error.flatten()));
    }
    const buffer = renderTicket(parsed.data, ctx.config.printer.width);
    ctx.log.info(
      {
        ticket_code: parsed.data.ticket_code,
        duplicate: parsed.data.duplicate,
        bytes: buffer.length,
      },
      'print: ticket',
    );
    const outcome = await send(buffer);
    return 'ok' in outcome
      ? reply.code(200).send(outcome)
      : reply.code(outcome.code).send(outcome.body);
  });

  app.post('/print/raw', async (request, reply) => {
    const parsed = PrintRawBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION', 'Corps de requête invalide', parsed.error.flatten()));
    }
    const buffer = Buffer.from(parsed.data.base64, 'base64');
    ctx.log.info({ bytes: buffer.length }, 'print: raw');
    const outcome = await send(buffer);
    return 'ok' in outcome
      ? reply.code(200).send(outcome)
      : reply.code(outcome.code).send(outcome.body);
  });

  app.post('/drawer/open', async (request, reply) => {
    const parsed = DrawerOpenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION', 'Corps de requête invalide', parsed.error.flatten()));
    }
    ctx.log.info({ reason: parsed.data.reason, pin: ctx.config.drawer.pin }, 'drawer: ouverture');
    const outcome = await send(buildDrawerPulse(ctx.config.drawer.pin));
    return 'ok' in outcome
      ? reply.code(200).send(outcome)
      : reply.code(outcome.code).send(outcome.body);
  });
}
