#!/usr/bin/env -S npx tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Project } from 'ts-morph';
import type { Finding, ModuleGraph, Source } from '../../schema/modulegraph.ts';
import { compare } from './compare.ts';
import { loadConfig } from './config.ts';
import { extract, type Snapshot } from './extract.ts';
import { diffBetween, fetchPullRequest, filesAtRef, mergeBase, repoRootOf, revParse, type RawDiff } from './git.ts';
import { architectureFindings, changeFindings, markNew, opLabel, reviewSummary } from './rules.ts';

const HELP = `modulegraph: module-level review graph for a TypeScript service

usage: modulegraph --project <dir> [mode] [options]

modes (default: --uncommitted)
  --uncommitted            working tree (incl. untracked) vs HEAD
  --head <ref> [--base <ref>]   branch/worktree ref vs merge-base with base (default base: main)
  --pr <number>            GitHub PR via gh (fetches head, uses PR description as intent)
  --snapshot               current tree, no diff

options
  --intent <text>          what the change is supposed to do (enables undisclosed-effect rule)
  --title <text>           label shown in the UI
  --name <id>              output id (default derived from mode)
  --out <file>             output path (default: ui/public/graphs/<id>.json, also updates index.json)
  --check                  exit 1 when the change introduces new error-level findings (CI gate)
`;

const { values: args } = parseArgs({
  options: {
    project: { type: 'string', default: '.' },
    repo: { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string' },
    uncommitted: { type: 'boolean' },
    pr: { type: 'string' },
    snapshot: { type: 'boolean' },
    intent: { type: 'string' },
    title: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string' },
    check: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const started = Date.now();
const projectDir = resolve(args.project!).replace(/\\/g, '/');
const repo = (args.repo ? resolve(args.repo) : repoRootOf(projectDir)).replace(/\\/g, '/');
const projectRel = relative(repo, projectDir).replace(/\\/g, '/') || '.';
const config = loadConfig(projectDir);
const tsconfig = join(projectDir, config.tsconfig);

function snapshotOf(files?: Map<string, string>): Snapshot {
  const project = files
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ tsConfigFilePath: tsconfig });
  if (files) for (const [path, text] of files) project.createSourceFile(path, text, { overwrite: true });
  return extract(project, repo, projectDir, config);
}

let head: Snapshot;
let base: Snapshot | undefined;
let diff: RawDiff | undefined;
let intent = args.intent;
let source: Source;

if (args.snapshot) {
  head = snapshotOf();
  source = { mode: 'snapshot', repo, project: projectRel, files: [] };
} else if (args.pr || args.head) {
  let headRef = args.head!;
  let baseRef = args.base ?? 'main';
  let title = args.title;
  if (args.pr) {
    const pr = fetchPullRequest(repo, Number(args.pr));
    headRef = pr.headRef;
    baseRef = pr.baseRef;
    title ??= `PR #${pr.number}: ${pr.title}`;
    intent ??= `${pr.title}\n${pr.body}`;
  }
  const mb = mergeBase(repo, baseRef, headRef);
  head = snapshotOf(filesAtRef(repo, revParse(repo, headRef), projectRel));
  base = snapshotOf(filesAtRef(repo, mb, projectRel));
  diff = diffBetween(repo, mb, headRef, projectRel);
  source = { mode: args.pr ? 'pr' : 'branch', repo, project: projectRel, base: baseRef, head: args.pr ? `#${args.pr}` : headRef, title, files: diff.files };
} else {
  head = snapshotOf();
  base = snapshotOf(filesAtRef(repo, 'HEAD', projectRel));
  diff = diffBetween(repo, 'HEAD', undefined, projectRel);
  source = { mode: 'uncommitted', repo, project: projectRel, base: 'HEAD', head: 'working tree', files: diff.files };
}
source.title ??= args.title;
if (intent) source.intent = intent;

const graph = compare(head, base);
for (const file of source.files) {
  file.modules = Object.values(graph.modules).filter((m) => m.file === file.path).map((m) => m.id);
}

let findings: Finding[] = architectureFindings(graph, config);
if (base) {
  findings = markNew(findings, architectureFindings(compare(base), config));
  findings.push(...changeFindings(graph, diff!, config, intent));
}

const output: ModuleGraph = {
  schema: 'modulegraph/v1',
  service: config.service,
  generatedAt: new Date().toISOString(),
  generator: 'modulegraph-analyzer/0.1 (ts-morph)',
  source,
  ...graph,
  findings,
  review: reviewSummary(graph, diff),
};

// ---------- write ----------
const here = dirname(fileURLToPath(import.meta.url));
const graphsDir = resolve(here, '../../ui/public/graphs');
const id = args.name ?? slug(source.mode === 'snapshot' ? `snapshot-${config.service}` : `${source.mode}-${source.head}`);
const outFile = args.out ? resolve(args.out) : join(graphsDir, `${id}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(output, null, 2));
if (!args.out) {
  const indexFile = join(graphsDir, 'index.json');
  const index = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, 'utf8')) as { id: string }[]) : [];
  const entry = {
    id,
    title: source.title ?? `${source.mode}: ${source.base ?? ''} → ${source.head ?? 'tree'}`,
    mode: source.mode,
    generatedAt: output.generatedAt,
    stats: output.review.stats,
  };
  writeFileSync(indexFile, JSON.stringify([entry, ...index.filter((e) => e.id !== id)], null, 2));
}

// ---------- report ----------
const r = output.review;
const ops = Object.keys(output.operations).length;
console.log(`\n${config.service}: ${Object.keys(output.modules).length} modules, ${ops} operations, ${Object.keys(output.entryPoints).length} entry points (${Date.now() - started} ms)`);
if (base) {
  console.log(`change: ${r.stats.files} files, +${r.stats.linesAdded}/−${r.stats.linesRemoved}, ${r.stats.contractChanges} contract changes, ${r.stats.entryPointsAffected} entry points affected`);
  if (r.queue.length) console.log('\nreview queue (riskiest first):');
  for (const q of r.queue) console.log(`  [${q.risk.padEnd(6)}] ${opLabel(output, q.operation).padEnd(40)} reach ${String(q.reach).padStart(2)}  ${q.reason}`);
  if (r.reviewers.length) console.log(`\nrequest review from: ${r.reviewers.join(', ')}`);
}
const shown = findings.filter((f) => f.isNew || !base);
if (shown.length) console.log(`\n${base ? 'new findings' : 'findings'}:`);
for (const f of shown) console.log(`  ${f.severity.toUpperCase().padEnd(7)} ${f.rule.padEnd(20)} ${f.message}`);
const preexisting = findings.length - shown.length;
if (preexisting) console.log(`  (+${preexisting} pre-existing findings, shown in the UI)`);
console.log(`\nwrote ${relative(process.cwd(), outFile)}`);

if (args.check && findings.some((f) => f.isNew && f.severity === 'error')) {
  console.error('\nmodulegraph check failed: the change introduces error-level findings');
  process.exit(1);
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}
