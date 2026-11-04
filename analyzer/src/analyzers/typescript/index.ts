import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import type { LanguageAnalyzer } from '../types.ts';
import { Extractor } from './extract.ts';
import { detectFrameworks } from './frameworks/index.ts';

/** TypeScript (and JavaScript with a tsconfig) through the type checker, with framework adapters. */
export const typescript: LanguageAnalyzer = {
  id: 'typescript',
  language: 'TypeScript',
  generator: 'modulegraph-analyzer/0.3 (typescript: ts-morph)',
  detect(projectDir) {
    if (existsSync(join(projectDir, 'tsconfig.json'))) return 'tsconfig.json';
    if (existsSync(join(projectDir, 'package.json'))) return 'package.json (no tsconfig.json: compiler defaults)';
    return undefined;
  },
  sourceFile: (path) => /\.(tsx?|mts|cts)$/.test(path) && !path.includes('node_modules/'),
  frameworks: (projectDir, config) => detectFrameworks(projectDir, config.frameworks).detected,
  open({ repo, projectDir, config, files }) {
    const tsconfig = join(projectDir, config.tsconfig);
    const options = existsSync(tsconfig) ? { tsConfigFilePath: tsconfig } : { compilerOptions: { allowJs: true, experimentalDecorators: true } };
    const project = files ? new Project({ ...options, skipAddingFilesFromTsConfig: true }) : new Project(options);
    if (!files && !existsSync(tsconfig)) project.addSourceFilesAtPaths(join(projectDir, 'src/**/*.{ts,tsx}').replace(/\\/g, '/'));
    if (files) for (const [path, text] of files) project.createSourceFile(path, text, { overwrite: true });
    return new Extractor(project, repo, projectDir, config, detectFrameworks(projectDir, config.frameworks).use);
  },
};
