/**
 * Module loader hook for the example recorder: compiles the analyzed service's .ts files with TypeScript itself
 * when its tsconfig sets `emitDecoratorMetadata` (NestJS dependency injection, TypeORM column types), which
 * tsx's esbuild does not emit. Everything else (the scenario, node_modules, the analyzer) is left to tsx.
 * Registered by examples-runner.ts with { root, options, esm }.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

let root = '';
let options = {};
let esm = true;

export function initialize(data) {
  root = data.root.replace(/\\/g, '/').toLowerCase();
  esm = data.esm;
  options = {
    ...data.options,
    module: esm ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
    sourceMap: false,
    inlineSourceMap: true,
    noEmit: false,
    declaration: false,
    verbatimModuleSyntax: false,
  };
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !/\.(c|m)?tsx?$/.test(url)) return nextLoad(url, context);
  const path = fileURLToPath(url);
  const norm = path.replace(/\\/g, '/').toLowerCase();
  if (!norm.startsWith(root) || norm.includes('/node_modules/')) return nextLoad(url, context);
  const text = await readFile(path, 'utf8');
  const out = ts.transpileModule(text, { compilerOptions: options, fileName: path });
  return { format: esm ? 'module' : 'commonjs', source: out.outputText, shortCircuit: true };
}
