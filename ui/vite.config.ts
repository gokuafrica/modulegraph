import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Reviews of your own services are written to ~/.modulegraph/reviews (MODULEGRAPH_HOME moves it), not into this repo. */
const reviewsDir = join(resolve(process.env.MODULEGRAPH_HOME ?? join(homedir(), '.modulegraph')), 'reviews');

/** Dev server: /graphs/* from your reviews folder first, then the demos in public/graphs; index.json lists both. */
function userReviews(): Plugin {
  return {
    name: 'modulegraph-user-reviews',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = /^\/graphs\/([^/?#]+)/.exec(req.url ?? '')?.[1];
        if (!name) return next();
        const read = (dir: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined);
        if (name === 'index.json') {
          const lists = [read(reviewsDir), read(join(__dirname, 'public/graphs'))].map((t) => (t ? (JSON.parse(t) as { id: string }[]) : []));
          // A demo explored live (npm run live) has a copy in your reviews too: list it once, yours first.
          const entries = lists.flat().filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify(entries));
        }
        const own = name.includes('..') ? undefined : read(reviewsDir);
        if (own === undefined) return next();
        res.setHeader('content-type', name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
        res.end(own);
      });
    },
  };
}

// File events are unreliable in synced folders (OneDrive, Dropbox): poll there, or when MODULEGRAPH_POLL is set.
const poll = !!process.env.MODULEGRAPH_POLL || /onedrive|dropbox/i.test(__dirname);

export default defineConfig({
  plugins: [react(), userReviews()],
  // /api goes to the live analysis server (`modulegraph review`), when one is running.
  server: { fs: { allow: ['..'] }, watch: poll ? { usePolling: true, interval: 300 } : undefined, proxy: { '/api': 'http://127.0.0.1:5174' } },
});
