/**
 * Language backends. modulegraph picks the first whose `detect` matches the project (or the one named with
 * `--analyzer` / the profile's `"analyzer"`). Projects no backend understands still get reviews through the agent
 * path: an agent writes modulegraph/v1 JSON directly (see .claude/skills/module-review/SKILL.md).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageAnalyzer } from './types.ts';
import { typescript } from './typescript/index.ts';

export const analyzers: LanguageAnalyzer[] = [typescript];

/** Marker files of languages modulegraph has no static backend for yet, so the error can say what was found. */
const OTHER_LANGUAGES: [string, string][] = [
  ['go.mod', 'Go'], ['pom.xml', 'Java'], ['build.gradle', 'Java/Kotlin'], ['build.gradle.kts', 'Kotlin'],
  ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['Cargo.toml', 'Rust'], ['Gemfile', 'Ruby'],
  ['composer.json', 'PHP'], ['mix.exs', 'Elixir'],
];

export function pickAnalyzer(projectDir: string, wanted?: string): { analyzer?: LanguageAnalyzer; reason: string } {
  if (wanted) {
    const analyzer = analyzers.find((a) => a.id === wanted);
    return analyzer ? { analyzer, reason: 'chosen explicitly' } : { reason: `unknown analyzer "${wanted}"; known: ${analyzers.map((a) => a.id).join(', ')}` };
  }
  for (const analyzer of analyzers) {
    const why = analyzer.detect(projectDir);
    if (why) return { analyzer, reason: why };
  }
  const files = existsSync(projectDir) ? readdirSync(projectDir) : [];
  const found = OTHER_LANGUAGES.filter(([f]) => files.includes(f)).map(([f, lang]) => `${lang} (${f})`);
  return { reason: found.length ? `no static analyzer for ${found.join(', ')} yet` : 'no known project files' };
}
