import type { FastifyInstance } from 'fastify';
import { buildDrawerCommand, type OutputOptions } from '../printer/builder.js';
import { renderReport } from '../printer/reportRenderer.js';
import { renderTicket } from '../printer/ticketRenderer.js';
import { PrinterError } from '../printer/transport.js';
import {
  DrawerOpenBodySchema,
  PrintRawBodySchema,
  ReportPayloadSchema,
  TicketPayloadSchema,
} from '../schemas.js';
import { errorBody, type BridgeContext } from './context.js';

export function registerPrintRoutes(app: FastifyInstance, ctx: BridgeContext): void {
  const { printer: printerConfig } = ctx.config;
  const output: OutputOptions = {
    commandSet: printerConfig.commandSet,
    cutter: printerConfig.cutter,
    ...(printerConfig.codepageNumber !== undefined
      ? { codepageNumber: printerConfig.codepageNumber }
      : {}),
  };

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
    const buffer = renderTicket(parsed.data, printerConfig.width, output);
    ctx.log.info(
      {
        ticket_code: parsed.data.ticket_code,
        duplicate: parsed.data.duplicate,
        training: parsed.data.compliance.training === true,
        bytes: buffer.length,
      },
      'print: ticket',
    );
    const outcome = await send(buffer);
    return 'ok' in outcome
      ? reply.code(200).send(outcome)
      : reply.code(outcome.code).send(outcome.body);
  });

  app.post('/print/report', async (request, reply) => {
    const parsed = ReportPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION', 'ReportPayload invalide', parsed.error.flatten()));
    }
    const buffer = renderReport(parsed.data, printerConfig.width, output);
    ctx.log.info(
      { kind: parsed.data.kind, training: parsed.data.training === true, bytes: buffer.length },
      'print: rapport',
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
    const outcome = await send(buildDrawerCommand(ctx.config.drawer.pin, output));
    return 'ok' in outcome
      ? reply.code(200).send(outcome)
      : reply.code(outcome.code).send(outcome.body);
  });
}
