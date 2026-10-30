import { buildApp } from './app.ts';
import { seed } from './dev/seed.ts';

const app = buildApp();
await seed(app);
const port = Number(process.env.PORT ?? 3001);
app.router.listen(port);
console.log(`identity-profile-service on http://localhost:${port}/v1/users/u-1/profile`);
