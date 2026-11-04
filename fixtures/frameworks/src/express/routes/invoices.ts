import { type NextFunction, type Request, type Response, Router } from 'express';
import type { InvoiceService } from '../services.ts';

type Handler = (req: Request, res: Response) => Promise<void>;

/** The usual wrapper that forwards async errors to Express. */
const asyncHandler = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export function invoicesRouter(invoices: InvoiceService): Router {
  const router = Router();

  router.get('/:id', asyncHandler(async (req, res) => {
    const invoice = await invoices.get(String(req.params.id));
    if (!invoice) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(invoice);
  }));

  router.post('/', async (req, res) => {
    res.status(201).json(await invoices.issue(req.body.customerId, req.body.amount));
  });

  router.route('/:id/pay').post(async (req, res) => {
    res.json(await invoices.pay(String(req.params.id)));
  });

  return router;
}
