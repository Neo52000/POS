import type { FastifyInstance } from 'fastify';
import { PaymentBusyError } from '../payments.js';
import { PaymentBodySchema, PaymentCancelBodySchema } from '../schemas.js';
import { errorBody, type BridgeContext } from './context.js';

export function registerPaymentRoutes(app: FastifyInstance, ctx: BridgeContext): void {
  app.post('/payment', async (request, reply) => {
    const parsed = PaymentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION', 'Corps de requête invalide', parsed.error.flatten()));
    }
    const { txn_id, amount_cents, kind } = parsed.data;
    try {
      const result = await ctx.payments.pay(txn_id, amount_cents, kind);
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof PaymentBusyError) {
        return reply.code(409).send({
          status: 'busy',
          code: 'BUSY',
          message: error.message,
          current_txn_id: error.current.txn_id,
          duration_ms: 0,
        });
      }
      throw error;
    }
  });

  app.post('/payment/cancel', async (request, reply) => {
    const parsed = PaymentCancelBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION', 'Corps de requête invalide', parsed.error.flatten()));
    }
    const cancelled = ctx.payments.cancel(parsed.data.txn_id);
    if (!cancelled) {
      const current = ctx.payments.current;
      return reply.code(409).send({
        ok: false,
        ...errorBody(
          'NOT_IN_PROGRESS',
          current
            ? `Le paiement en cours concerne la transaction ${current.txn_id}`
            : 'Aucun paiement en cours',
        ),
      });
    }
    return reply.code(200).send({ ok: true });
  });
}
