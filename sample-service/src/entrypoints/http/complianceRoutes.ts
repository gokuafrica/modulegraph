import type { Modules } from '../../app.ts';
import { HttpRouter } from '../../platform/http.ts';

export function registerComplianceRoutes(router: HttpRouter, m: Modules): void {
  router.post('/v1/kyc/:userId/check', (req) => m.kyc.runCheck(req.params.userId));
  router.get('/v1/kyc/:userId/status', (req) => m.kyc.getStatus(req.params.userId));
  router.post('/v1/onboarding/:userId/complete', (req) => m.onboarding.complete(req.params.userId));
  router.get('/v1/tax/:userId/residency', (req) => m.tax.assess(req.params.userId));
  router.post('/v1/tax/:userId/declarations', (req) => m.tax.recordDeclaration(req.params.userId, req.body.country));
  router.get('/v1/travel/:userId/visa-eligibility', (req) => m.travel.checkVisa(req.params.userId, req.query.destination));
  router.post('/v1/travel/:userId/passport-prefill', (req) => m.travel.prefillPassport(req.params.userId));
}
