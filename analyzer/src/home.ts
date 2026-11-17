/**
 * Where modulegraph keeps things. The tool's checkout (this repo) holds the code, the demos and their profiles.
 * Everything about *your* services lives in your modulegraph home, outside both the tool and the analyzed code:
 *
 *   ~/.modulegraph/configs/<service>/   profiles (modulegraph.config.json, optional scenario.ts)
 *   ~/.modulegraph/reviews/             review graphs and briefs (<id>.json, <id>.brief.md)
 *
 * MODULEGRAPH_HOME moves it. Updating the tool (git pull) never touches it, and nothing in it is ever published.
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The modulegraph checkout. */
export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..').replace(/\\/g, '/');
export const homeDir = resolve(process.env.MODULEGRAPH_HOME ?? join(homedir(), '.modulegraph')).replace(/\\/g, '/');
export const userConfigsDir = join(homeDir, 'configs').replace(/\\/g, '/');
export const userReviewsDir = join(homeDir, 'reviews').replace(/\\/g, '/');
/** The demos' profiles and saved graphs, shipped with the tool. */
export const demoConfigsDir = join(appRoot, 'configs').replace(/\\/g, '/');
export const demoGraphsDir = join(appRoot, 'ui/public/graphs').replace(/\\/g, '/');
/** The built UI (`npm run setup` builds it), served by `modulegraph review` itself. */
export const uiDistDir = join(appRoot, 'ui/dist').replace(/\\/g, '/');

/** True for paths inside the modulegraph checkout (the demo services). */
export function insideApp(path: string): boolean {
  const rel = relative(appRoot, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Reviews go to your modulegraph home. Only `npm run demo` (cli.ts --demo) writes the shipped demo graphs, which are
 * kept in git: an ad-hoc review of a demo service, or a live demo saving what was explored, must not change them.
 */
export function graphsDirFor(projectDir: string, demo = false): string {
  return demo && insideApp(projectDir) ? demoGraphsDir : userReviewsDir;
}

/** Profile folders to search, yours first. */
export function profileDirs(): string[] {
  return [userConfigsDir, demoConfigsDir];
}
