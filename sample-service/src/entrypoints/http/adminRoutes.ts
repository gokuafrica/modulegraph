import type { Modules } from '../../app.ts';
import { HttpRouter } from '../../platform/http.ts';

export function registerAdminRoutes(router: HttpRouter, m: Modules): void {
  router.get('/admin/v1/users/:userId/identity-review', (req) => m.review.review(req.params.userId));
  router.post('/admin/v1/users/:userId/kyc-override', (req) => m.kyc.override(req.params.userId, req.body.status, req.body.reviewer));
}
