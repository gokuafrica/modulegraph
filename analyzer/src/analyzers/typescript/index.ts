import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemRefreshResult, Project } from 'ts-morph';
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
    if (!files && !existsSync(tsconfig)) project.addSourceFilesAtPaths(srcGlob(projectDir));
    if (files) for (const [path, text] of files) project.createSourceFile(path, text, { overwrite: true });
    return new Extractor(project, repo, projectDir, config, detectFrameworks(projectDir, config.frameworks).use);
  },
  // The parsed program is kept: only files whose text changed are parsed again, and the type checker is rebuilt
  // from the old program (TypeScript reuses every unchanged file). The analysis itself starts fresh.
  reopen(prev, { repo, projectDir, config, files }) {
    const project = (prev as Extractor).project;
    const changedFiles: string[] = [];
    if (files) {
      for (const sf of project.getSourceFiles()) {
        if (!files.has(sf.getFilePath()) && !sf.isInNodeModules()) {
          changedFiles.push(sf.getFilePath());
          project.removeSourceFile(sf);
        }
      }
      for (const [path, text] of files) {
        const sf = project.getSourceFile(path);
        if (!sf) project.createSourceFile(path, text);
        else if (sf.getFullText() === text) continue;
        else sf.replaceWithText(text);
        changedFiles.push(path);
      }
    } else {
      // Working tree: re-read every file from disk (unchanged text is not parsed again), then pick up new ones.
      const before = new Set(project.getSourceFiles().map((sf) => sf.getFilePath()));
      for (const sf of project.getSourceFiles()) {
        if (sf.isInNodeModules() || sf.isDeclarationFile()) continue;
        const path = sf.getFilePath();
        if (sf.refreshFromFileSystemSync() !== FileSystemRefreshResult.NoChange) changedFiles.push(path);
      }
      const tsconfig = join(projectDir, config.tsconfig);
      const added = existsSync(tsconfig) ? project.addSourceFilesFromTsConfig(tsconfig) : project.addSourceFilesAtPaths(srcGlob(projectDir));
      for (const sf of added) if (!before.has(sf.getFilePath())) changedFiles.push(sf.getFilePath());
    }
    return { analysis: new Extractor(project, repo, projectDir, config, detectFrameworks(projectDir, config.frameworks).use), changedFiles };
  },
};

const srcGlob = (projectDir: string) => join(projectDir, 'src/**/*.{ts,tsx}').replace(/\\/g, '/');
