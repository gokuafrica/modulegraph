/**
 * Shows saved reviews (yours in ~/.modulegraph/reviews, then the demos') in the browser, without analyzing anything.
 * usage: modulegraph open [<review id>] [--port 5174]
 */
import { parseArgs } from 'node:util';
import { demoGraphsDir, uiDistDir, userReviewsDir } from './home.ts';
import { serveStatic } from './server.ts';

const { values, positionals } = parseArgs({ options: { port: { type: 'string' } }, allowPositionals: true });
serveStatic({ graphsDirs: [userReviewsDir, demoGraphsDir], uiDir: uiDistDir, port: Number(values.port ?? 5174), open: positionals[0] });
