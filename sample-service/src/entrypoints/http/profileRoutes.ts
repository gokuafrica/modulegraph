import type { Modules } from '../../app.ts';
import { HttpRouter } from '../../platform/http.ts';

export function registerProfileRoutes(router: HttpRouter, m: Modules): void {
  router.get('/v1/users/:userId/profile', (req) => m.profile.getProfile(req.params.userId));
  router.get('/v1/users/:userId/profile/summary', (req) => m.profile.getSummary(req.params.userId));
  router.get('/v1/users/:userId/nationality', (req) => m.profile.getNationality(req.params.userId));
  router.get('/v1/users/:userId/birth-info', (req) => m.profile.getBirthInfo(req.params.userId));
  router.put('/v1/users/:userId/birth-info/consent', (req) =>
    m.birthInfo.recordConsent(req.params.userId, req.body.countryOfBirth, req.body.cityOfBirth),
  );
  router.post('/v1/users/:userId/export', (req) => m.profile.exportProfile(req.params.userId));
  router.delete('/v1/users/:userId', (req) => m.profile.purge(req.params.userId));
}
