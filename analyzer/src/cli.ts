#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Example, Finding, ModuleGraph, Source } from '../../schema/modulegraph.ts';
import { pickAnalyzer } from './analyzers/index.ts';
import type { OperationTarget, RevisionAnalysis } from './analyzers/types.ts';
import { compare } from './compare.ts';
import { findProfile, loadConfig } from './config.ts';
import { brief } from './brief.ts';
import { LazySession } from './lazy.ts';
import { serve } from './server.ts';
import { commitMessages, diffBetween, fetchPullRequest, filesAtRef, git, mergeBase, repoRootOf, revParse, type RawDiff } from './git.ts';
import { architectureFindings, changeFindings, markNew, modulesOfFile, opLabel, reviewSummary } from './rules.ts';

const HELP = `modulegraph: module-level review graph for a service

usage: modulegraph --project <dir> [mode] [options]

modes (default: --uncommitted)
  --uncommitted            working tree (incl. untracked) vs HEAD
  --head <ref> [--base <ref>]   branch/worktree ref vs merge-base with base (default base: main)
  --pr <number>            GitHub PR via gh (fetches head, uses PR description as intent)
  --snapshot               current tree, no diff

options
  --intent <text>          what the change is supposed to do (enables undisclosed-effect rule)
  --config <file>          (default: the profile in configs/ whose service = the project's package name)
                           modulegraph config kept OUTSIDE the analyzed repo (platform classes, owners,
                           module names/contracts). The analyzed code is never modified
  --no-examples            don't run the profile's scenario
  --examples <file>        scenario script (outside the repo) run against the head revision; records real
                           inputs/outputs per operation. Branches/PRs run in a temporary git worktree
  --analyzer <id>          language backend (default: detected; known: typescript)
  --frameworks <a,b>       framework adapters to use instead of the detected ones (nestjs, express, fastify,
                           kafkajs, bullmq, node-cron, typeorm, prisma, mongoose, axios, fetch)
  --title <text>           label shown in the UI
  --name <id>              output id (default derived from mode)
  --out <file>             output path (default: ui/public/graphs/<id>.json, also updates index.json)
  --check                  exit 1 when the change introduces new error-level findings (CI gate)

lazy analysis (large codebases)
  --lazy                   start at the changed code; analyze only the few entry points that matter for
                           this change, list the rest without analyzing them
  --seeds <n>              entry points to analyze up front (default 2)
  --seed-entries <a,b>     entry point ids or label fragments to analyze up front (e.g. an agent's pick)
  --serve [--port 5174]    keep running and answer the UI's expand requests (callers, flows, drill-ins)
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
    examples: { type: 'string' },
    config: { type: 'string' },
    title: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string' },
    check: { type: 'boolean' },
    'no-examples': { type: 'boolean' },
    lazy: { type: 'boolean' },
    seeds: { type: 'string' },
    'seed-entries': { type: 'string' },
    serve: { type: 'boolean' },
    port: { type: 'string' },
    analyzer: { type: 'string' },
    frameworks: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const started = Date.now();
// `npm run analyze` runs in analyzer/; INIT_CWD is where the command was typed. Relative paths mean that folder.
const userCwd = process.env.INIT_CWD ?? process.cwd();
const fromUser = (p: string) => resolve(userCwd, p);
const projectDir = fromUser(args.project!).replace(/\\/g, '/');
if (!existsSync(projectDir)) {
  console.error(`project folder not found: ${projectDir} (paths are relative to ${userCwd})`);
  process.exit(2);
}
const repo = (args.repo ? fromUser(args.repo) : repoRootOf(projectDir)).replace(/\\/g, '/');
const projectRel = relative(repo, projectDir).replace(/\\/g, '/') || '.';
// No --config: use the profile in configs/ whose service matches the project's package name.
const profile = args.config ? undefined : findProfile(projectDir, resolve(dirname(fileURLToPath(import.meta.url)), '../../configs'));
if (!args.config) {
  console.log(profile?.config
    ? `profile: ${relative(process.cwd(), profile.config)} (found by package name)`
    : `profile: none found (looked for ${profile?.tried}); using defaults. Write one: .claude/skills/module-review/SKILL.md, step 4`);
}
const configFile = args.config ? fromUser(args.config) : profile?.config;
const config = loadConfig(projectDir, configFile);
if (args.frameworks) config.frameworks = args.frameworks.split(',').map((f) => f.trim()).filter(Boolean);
// The profile's scenario records example data unless told otherwise.
if (!args.examples && !args['no-examples'] && profile?.scenario) args.examples = profile.scenario;

// The language backend: picked from the project's files, or named with --analyzer / the profile's "analyzer".
const picked = pickAnalyzer(projectDir, args.analyzer ?? config.analyzer);
if (!picked.analyzer) {
  console.error(`analyzer: ${picked.reason}.`);
  console.error('Review it through the agent path instead: write modulegraph/v1 JSON (.claude/skills/module-review/SKILL.md, "Services no backend understands").');
  process.exit(2);
}
const analyzer = picked.analyzer;
const detectedFrameworks = analyzer.frameworks(projectDir, config);
const frameworkList = detectedFrameworks.map((f) => `${f.name} (${f.reason})`).join(', ');
console.log(`analyzer: ${analyzer.id} (${picked.reason})`);
console.log(`frameworks: ${frameworkList || "none recognised; only the profile's rules apply"}`);
const open = (files?: Map<string, string>) => analyzer.open({ repo, projectDir, config, files });
const filesAt = (ref: string) => filesAtRef(repo, ref, projectRel, analyzer.sourceFile);

let headProject: RevisionAnalysis;
let baseProject: RevisionAnalysis | undefined;
let diff: RawDiff | undefined;
let intent = args.intent;
let intentSource: Source['intentSource'] = intent ? 'flag' : undefined;
let source: Source;
/** Commit the head side was read from; undefined = working tree. */
let headSha: string | undefined;

if (args.snapshot) {
  headProject = open();
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
    if (!intent) {
      intent = `${pr.title}\n${pr.body}`;
      intentSource = 'pr';
    }
  }
  const mb = mergeBase(repo, baseRef, headRef);
  if (!intent || !title) {
    // No PR text given: the branch's own commit messages say what it is for.
    const fromCommits = commitMessages(repo, mb, headRef);
    title ??= fromCommits.title ?? headRef;
    if (!intent && fromCommits.intent) {
      intent = fromCommits.intent;
      intentSource = 'commits';
    }
  }
  headSha = revParse(repo, headRef);
  headProject = open(filesAt(headSha));
  baseProject = open(filesAt(mb));
  diff = diffBetween(repo, mb, headRef, projectRel);
  source = { mode: args.pr ? 'pr' : 'branch', repo, project: projectRel, base: baseRef, head: args.pr ? `#${args.pr}` : headRef, title, files: diff.files };
} else {
  headProject = open();
  baseProject = open(filesAt('HEAD'));
  diff = diffBetween(repo, 'HEAD', undefined, projectRel);
  source = { mode: 'uncommitted', repo, project: projectRel, base: 'HEAD', head: 'working tree', files: diff.files };
}
source.title ??= args.title;
source.analyzer = { id: analyzer.id, language: analyzer.language, frameworks: detectedFrameworks };
if (intent) {
  source.intent = intent;
  source.intentSource = intentSource;
}

const here = dirname(fileURLToPath(import.meta.url));
const graphsDir = resolve(here, '../../ui/public/graphs');
const id = args.name ?? slug(source.mode === 'snapshot' ? `snapshot-${config.service}` : `${source.mode}-${source.head}`);
const outFile = args.out ? fromUser(args.out) : join(graphsDir, `${id}.json`);

let output: ModuleGraph;
let session: LazySession | undefined;

if (args.lazy) {
  // Only what the review needs: the changed code, a few relevant entry points, the rest on demand.
  session = new LazySession(headProject, baseProject, repo, config, diff, source, intent, {}, analyzer.generator);
  session.init({ seedCount: Number(args.seeds ?? 2), seedHints: args['seed-entries']?.split(',').map((x) => x.trim()).filter(Boolean) });
  if (args.examples) session.examples = recordExamples(args.examples, session.exampleTargets());
  output = session.graph();
  if (args.serve) output.lazy!.api = '/api';
} else {
  const head = headProject.run();
  const base = baseProject?.run();
  const graph = compare(head, base);
  for (const file of source.files) {
    file.modules = modulesOfFile(graph, file.path);
  }
  if (args.examples) {
    const targets = Object.values(graph.operations)
      .filter((op) => op.change !== 'removed')
      .map((op) => ({ opId: op.id, file: op.file, className: graph.modules[op.moduleId].className, method: op.name, params: op.params.map((p) => p.name) }));
    const recorded = recordExamples(args.examples, targets);
    for (const [opId, examples] of Object.entries(recorded)) if (graph.operations[opId]) graph.operations[opId].examples = examples;
  }
  let findings: Finding[] = architectureFindings(graph, config);
  if (base) {
    findings = markNew(findings, architectureFindings(compare(base), config));
    findings.push(...changeFindings(graph, diff!, config, intent));
  }
  output = {
    schema: 'modulegraph/v1',
    service: config.service,
    generatedAt: new Date().toISOString(),
    generator: analyzer.generator,
    source,
    ...graph,
    findings,
    review: reviewSummary(graph, diff),
  };
}

// ---------- write ----------
const briefFile = outFile.replace(/\.json$/, '') + '.brief.md';
function write(graph: ModuleGraph): void {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(graph, null, 2));
  writeFileSync(briefFile, brief(graph, id));
  if (args.out) return;
  const indexFile = join(graphsDir, 'index.json');
  const index = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, 'utf8')) as { id: string }[]) : [];
  const entry = {
    id,
    title: source.title ?? `${source.mode}: ${source.base ?? ''} → ${source.head ?? 'tree'}`,
    mode: source.mode,
    lazy: !!graph.lazy,
    generatedAt: graph.generatedAt,
    stats: graph.review.stats,
  };
  writeFileSync(indexFile, JSON.stringify([entry, ...index.filter((e) => e.id !== id)], null, 2));
}
write(output);
const findings = output.findings;
const base = baseProject;

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
if (output.lazy) {
  const st = output.lazy.stats;
  console.log(`\nlazy: analyzed ${st.entryPointsAnalyzed} of ${st.entryPointsKnown} entry points (${st.entryPointsReached} more known to reach the change), ${st.operationsAnalyzed} of ${st.operationsKnown} operations, ${st.ms} ms`);
  for (const s of output.lazy.seeds) console.log(`  seed ${s.id}: ${s.reason}`);
}
console.log(`\nwrote ${relative(process.cwd(), outFile)}`);
console.log(`wrote ${relative(process.cwd(), briefFile)}   <- review facts for agents and people: start here`);

if (args.serve && session) serve(session, write, id, Number(args.port ?? 5174));

if (args.check && findings.some((f) => f.isNew && f.severity === 'error')) {
  console.error('\nmodulegraph check failed: the change introduces error-level findings');
  process.exit(1);
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

/** Runs the scenario against the head revision and returns the recorded calls per operation. */
function recordExamples(scenarioRel: string, targets: OperationTarget[]): Record<string, Example[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  // One folder per process: several analyses (npm run live) may record examples at the same time.
  const tmp = join(repo, '.modulegraph-tmp', String(process.pid));
  mkdirSync(tmp, { recursive: true });
  let codeRoot = repo;
  let worktree: string | undefined;
  if (headSha) {
    worktree = join(tmp, `wt-${headSha.slice(0, 10)}`).replace(/\\/g, '/');
    if (existsSync(worktree)) git(repo, ['worktree', 'remove', '--force', worktree]);
    git(repo, ['worktree', 'add', '--detach', worktree, headSha]);
    codeRoot = worktree;
  }
  try {
    const scenario = fromUser(scenarioRel);
    if (!existsSync(scenario)) throw new Error(`scenario not found: ${scenarioRel}`);
    const projectRoot = join(codeRoot, projectRel).replace(/\\/g, '/');
    const out = join(tmp, 'examples.json');
    const spec = join(tmp, 'examples-spec.json');
    writeFileSync(spec, JSON.stringify({ scenario, projectRoot, out, targets: targets.map((t) => ({ ...t, file: join(codeRoot, t.file) })) }));
    execFileSync(process.execPath, ['--import', 'tsx', join(here, 'examples-runner.ts'), spec], { cwd: resolve(here, '..'), stdio: 'inherit' });
    const recorded = JSON.parse(readFileSync(out, 'utf8')) as Record<string, Example[]>;
    source.examples = { scenario: relative(resolve(here, '../..'), scenario).replace(/\\/g, '/'), operationsCovered: Object.keys(recorded).length };
    rmSync(out, { force: true });
    rmSync(spec, { force: true });
    return recorded;
  } finally {
    if (worktree) git(repo, ['worktree', 'remove', '--force', worktree]);
    rmSync(tmp, { recursive: true, force: true });
  }
}
