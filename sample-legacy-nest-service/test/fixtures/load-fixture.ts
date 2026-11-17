import { readFileSync } from 'fs';
import { globSync } from 'glob';

/** Reads a JSON fixture by name from test/fixtures (any subfolder). */
export function loadFixture<T = any>(name: string): T {
  const [file] = globSync(`**/${name}.json`, { cwd: __dirname, absolute: true });
  if (!file) {
    throw new Error(`fixture ${name} not found in test/fixtures`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
