/**
 * Shows saved reviews (yours in ~/.modulegraph/reviews, then the demos') in the browser, without analyzing anything.
 * usage: modulegraph open [<review id>] [--port 5174] [--idle <minutes>]
 */
import { parseArgs } from 'node:util';
import { demoGraphsDir, uiDistDir, userReviewsDir } from './home.ts';
import { serveStatic } from './server.ts';

const { values, positionals } = parseArgs({ options: { port: { type: 'string' }, idle: { type: 'string' } }, allowPositionals: true });
const idleMinutes = values.idle === undefined ? undefined : Number(values.idle);
if (idleMinutes !== undefined && !(idleMinutes >= 0)) {
  console.error('--idle takes a number of minutes (0 = never stop by itself)');
  process.exit(2);
}
serveStatic({ graphsDirs: [userReviewsDir, demoGraphsDir], uiDir: uiDistDir, port: Number(values.port ?? 5174), open: positionals[0], idleMinutes });
