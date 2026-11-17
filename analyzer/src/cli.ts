#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Example, ExampleCase, Finding, ModuleGraph, Source } from '../../schema/modulegraph.ts';
import { pickAnalyzer } from './analyzers/index.ts';
import type { OperationTarget, RevisionAnalysis } from './analyzers/types.ts';
import { compare } from './compare.ts';
import { findProfile, loadConfig } from './config.ts';
import { appRoot, graphsDirFor, insideApp, profileDirs, uiDistDir, userConfigsDir } from './home.ts';
import { brief } from './brief.ts';
import { analysisIssues, issueLines } from './coverage.ts';
import { endReview, recordRepo } from './cleanup.ts';
import { describe, descriptionsKey, unmatchedDescriptions } from './describe.ts';
import { LazySession } from './lazy.ts';
import { changeNames, jestConfigOf, recordTestExamples, type TestExamplesResult } from './test-examples.ts';
import { type RefreshResult, serve } from './server.ts';
import { commitMessages, currentBranch, defaultBranch, diffBetween, fetchPullRequest, filesAtRef, git, hasLocalChanges, mergeBase, repoRootOf, revParse, workingStateKey, type RawDiff } from './git.ts';
import { architectureFindings, changeFindings, markNew, modulesOfFile, opLabel, reviewSummary } from './rules.ts';

const HELP = `modulegraph: module-level review graph for a service

usage: modulegraph --project <dir> [mode] [options]

modes (default: the branch checked out in --project vs the repo's default branch, committed AND
 uncommitted, as --base <default branch>; on the default branch itself that is just what isn't committed)
  --uncommitted            working tree (incl. untracked) vs HEAD: only what isn't committed yet
  --base <ref>             the branch checked out in --project, committed AND uncommitted, vs merge-base with
                           <ref>: "my branch as I edit it"
  --head <ref> [--base <ref>]   branch ref vs merge-base with base (default base: the repo's default branch). Read from git, no
                           checkout needed. If <ref> is checked out in --project and has uncommitted edits
                           (you are fixing the PR locally), they are included; --committed reads the commit only
  --pr <number>            GitHub PR via gh (fetches head, uses PR description as intent); like --head
  --snapshot               current tree, no diff

options
  --intent <text>          what the change is supposed to do (enables undisclosed-effect rule)
  --config <file>          (default: the profile whose service = the project's package name, in
                           ~/.modulegraph/configs/, then the demos' configs/)
                           modulegraph config kept OUTSIDE the analyzed repo (platform classes, owners,
                           module names/contracts). The analyzed code is never modified
  --no-examples            don't record example data (no scenario, no tests)
  --no-tests               don't record examples from the service's tests (without a scenario, the Jest specs that
                           reference the changed classes and their callers are run to record example data)
  --tests                  record examples from tests for a PR too (off for --pr: it runs the PR's code)
  --tests-timeout <s>      stop the test run after this many seconds (default 120)
  --examples <file>        scenario script (outside the repo) run against the head revision; records real
                           inputs/outputs per operation. Branches/PRs run in a temporary git worktree
  --analyzer <id>          language backend (default: detected; known: typescript)
  --frameworks <a,b>       framework adapters to use instead of the detected ones (nestjs, express, fastify,
                           kafkajs, bullmq, node-cron, typeorm, prisma, mongoose, axios, fetch)
  --title <text>           label shown in the UI
  --name <id>              output id (default derived from mode)
  --out <file>             output path (default: ~/.modulegraph/reviews/<id>.json, also updates index.json)
  --demo                   write to the shipped demo graphs (ui/public/graphs/, kept in git) instead: only for
                           a demo service inside the modulegraph folder (npm run demo uses it)
  --check                  exit 1 when the change introduces new error-level findings (CI gate), or when the
                           analysis is incomplete (packages not installed, changed code in no known flow)
  --allow-incomplete       with --check: don't fail only because the analysis is incomplete

lazy analysis (large codebases)
  --lazy                   start at the changed code; analyze only the few entry points that matter for
                           this change, list the rest without analyzing them
  --seeds <n>              entry points to analyze up front (default 2)
  --seed-entries <a,b>     entry point ids or label fragments to analyze up front (e.g. an agent's pick)
  --serve [--port 5174]    keep running: serves the review UI (http://127.0.0.1:5174) and answers its expand and
                           refresh requests. Refresh re-reads only the files that changed since the last
                           analysis and keeps the base side's analysis. Only this machine can connect
  --open                   with --serve: open the review in the browser
  --idle <minutes>         with --serve: stop after this many minutes with no requests (default 30; 0 = never).
                           An open review tab asks every 5 s while it is visible, so this means nobody is looking
  --resume <file>          a saved review (<id>.json) to continue: what was explored in it is analyzed again and its
                           recorded examples are kept (modulegraph open uses this to serve a saved review live)

ending reviews (see modulegraph help): modulegraph stop [<id>] | done [<id>] | clean [--older-than <days>]
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
    committed: { type: 'boolean' },
    intent: { type: 'string' },
    examples: { type: 'string' },
    config: { type: 'string' },
    title: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string' },
    demo: { type: 'boolean' },
    check: { type: 'boolean' },
    'allow-incomplete': { type: 'boolean' },
    'no-examples': { type: 'boolean' },
    'no-tests': { type: 'boolean' },
    tests: { type: 'boolean' },
    'tests-timeout': { type: 'string' },
    lazy: { type: 'boolean' },
    seeds: { type: 'string' },
    'seed-entries': { type: 'string' },
    serve: { type: 'boolean' },
    port: { type: 'string' },
    open: { type: 'boolean' },
    idle: { type: 'string' },
    analyzer: { type: 'string' },
    frameworks: { type: 'string' },
    resume: { type: 'string' },
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
// The real path: git prints the repo root in long form, so a Windows short name (C:/Users/ABCDEF~1/…) or a
// symlinked folder would otherwise look like it lies outside the repo.
const realFolder = (p: string) => (existsSync(p) ? realpathSync.native(p) : p).replace(/\\/g, '/');
const projectDir = realFolder(fromUser(args.project!));
if (!existsSync(projectDir)) {
  console.error(`project folder not found: ${projectDir} (paths are relative to ${userCwd})`);
  process.exit(2);
}
const repo = args.repo ? realFolder(fromUser(args.repo)) : repoRootOf(projectDir).replace(/\\/g, '/');
const projectRel = relative(repo, projectDir).replace(/\\/g, '/') || '.';
// So `modulegraph clean` can find this repo's leftovers (PR refs, scenario temp folders) after its reviews are gone.
recordRepo(repo);
// No mode: the branch checked out, committed and uncommitted, vs the repo's default branch ("review my work").
if (!args.pr && !args.head && !args.base && !args.uncommitted && !args.snapshot) {
  const main = defaultBranch(repo);
  if (main) args.base = main;
  else args.uncommitted = true;
}
// No --config: use the profile whose service matches the project's package name (yours first, then the demos').
const profile = args.config ? undefined : findProfile(projectDir, profileDirs());
if (profile) {
  console.log(profile.config
    ? `profile: ${profile.config} (found by package name)`
    : `profile: none found for "${profile.name}"; using defaults. To add one, write ${userConfigsDir}/${profile.name}/modulegraph.config.json (the module-review skill, step 4)`);
}
const configFile = args.config ? fromUser(args.config) : profile?.config;
/** A saved review being continued (`modulegraph open`): its PR text, what was explored, its examples. */
const resumed = args.resume ? (JSON.parse(readFileSync(fromUser(args.resume), 'utf8')) as ModuleGraph) : undefined;
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

/**
 * What is being reviewed, read from git (cheap: no analysis). Run again on every refresh.
 *
 * The head side is a commit, or the working tree when the reviewed branch is the one checked out in --project and
 * has uncommitted edits: fixing a PR locally shows the fixes in its review. `--committed` reads the commit only.
 */
interface Revisions {
  /** Commit the head side is read from; undefined = the working tree. */
  headSha?: string;
  /** Commit the base side is read from (merge-base, or HEAD for --uncommitted); undefined = no base (snapshot). */
  baseSha?: string;
  diff?: RawDiff;
  source: Source;
  intent?: string;
}

function resolveRevisions(): Revisions {
  let intent = args.intent;
  let intentSource: Source['intentSource'] = intent ? 'flag' : undefined;
  let r: Revisions;
  if (args.snapshot) {
    r = { source: { mode: 'snapshot', repo, project: projectRel, files: [] } };
  } else if (args.pr || args.head || args.base) {
    // --base alone: the branch checked out in --project, with whatever is not committed yet.
    let headRef = args.head ?? currentBranch(repo);
    let baseRef = args.base ?? defaultBranch(repo) ?? 'main';
    let title = args.title;
    if (args.pr && resumed?.source.mode === 'pr' && resumed.source.base) {
      // Continuing a saved PR review: the PR ref it fetched is still there; no need to ask GitHub again.
      headRef = `refs/modulegraph/pr-${Number(args.pr)}`;
      baseRef = resumed.source.base;
      title ??= resumed.source.title;
      if (!intent && resumed.source.intent) {
        intent = resumed.source.intent;
        intentSource = resumed.source.intentSource ?? 'pr';
      }
    } else if (args.pr) {
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
    const sha = revParse(repo, headRef);
    const workingTree = !args.committed && revParse(repo, 'HEAD') === sha && hasLocalChanges(repo, projectRel);
    const diff = diffBetween(repo, mb, workingTree ? undefined : sha, projectRel);
    r = {
      headSha: workingTree ? undefined : sha,
      baseSha: mb,
      diff,
      source: { mode: args.pr ? 'pr' : 'branch', repo, project: projectRel, base: baseRef, head: args.pr ? `#${args.pr}` : headRef, title, files: diff.files, ...(workingTree ? { workingTree: true } : {}) },
    };
  } else {
    const diff = diffBetween(repo, 'HEAD', undefined, projectRel);
    r = { baseSha: revParse(repo, 'HEAD'), diff, source: { mode: 'uncommitted', repo, project: projectRel, base: 'HEAD', head: 'working tree', files: diff.files, workingTree: true } };
  }
  // The demos' saved graphs are shipped: no machine's folder names in them.
  if (insideApp(repo)) r.source.repo = relative(appRoot, repo).replace(/\\/g, '/') || '.';
  r.source.title ??= args.title;
  r.source.analyzer = { id: analyzer.id, language: analyzer.language, frameworks: detectedFrameworks };
  const profilePath = configFile ?? `${userConfigsDir}/${config.service}/modulegraph.config.json`;
  r.source.profile = { path: displayHome(profilePath), exists: !!configFile && existsSync(configFile) };
  r.source.command = reviewCommand(r.source);
  if (intent) {
    r.source.intent = intent;
    r.source.intentSource = intentSource;
    r.intent = intent;
  }
  return r;
}

/** Source files of a commit, re-reading from git only what changed since the commit `prev` was read from. */
const fileCache = new Map<string, Map<string, string>>();
function filesOf(sha: string, prevSha?: string): Map<string, string> {
  const cached = fileCache.get(sha);
  if (cached) return cached;
  const prev = prevSha ? fileCache.get(prevSha) : undefined;
  let files: Map<string, string>;
  if (prev) {
    files = new Map(prev);
    for (const path of git(repo, ['diff', '--name-only', prevSha!, sha, '--', projectRel]).split('\n').filter((p) => p && analyzer.sourceFile(p))) {
      const abs = join(repo, path).replace(/\\/g, '/');
      try {
        files.set(abs, git(repo, ['show', `${sha}:${path}`]));
      } catch {
        files.delete(abs);
      }
    }
  } else {
    files = filesAt(sha);
  }
  fileCache.set(sha, files);
  return files;
}

let revisions = resolveRevisions();
let source = revisions.source;
let intent = revisions.intent;
/** Commit the head side was read from; undefined = working tree. */
let headSha = revisions.headSha;
let diff = revisions.diff;
let headProject: RevisionAnalysis = open(headSha ? filesOf(headSha) : undefined);
let baseProject: RevisionAnalysis | undefined = revisions.baseSha ? open(filesOf(revisions.baseSha)) : undefined;

const graphsDir = graphsDirFor(projectDir, !!args.demo);
if (args.demo && !insideApp(projectDir)) console.log('--demo: only demo services inside the modulegraph folder write the shipped graphs; this one goes to your reviews.');
const id = args.name ?? slug(source.mode === 'snapshot' ? `snapshot-${config.service}` : `${source.mode}-${source.head}`);
const outFile = args.out ? fromUser(args.out) : join(graphsDir, `${id}.json`);

let output: ModuleGraph;
let session: LazySession | undefined;

if (args.lazy) {
  // Only what the review needs: the changed code, a few relevant entry points, the rest on demand.
  session = new LazySession(headProject, baseProject, repo, config, diff, source, intent, {}, analyzer.generator);
  session.init({ seedCount: Number(args.seeds ?? 2), seedHints: args['seed-entries']?.split(',').map((x) => x.trim()).filter(Boolean) });
  if (resumed) resume(session, resumed);
  if (resumed && Object.values(resumed.operations).some((op) => op.examples?.length)) {
    // Recorded on this code before: keep them (a refresh records them again when the code changes).
    session.examples = Object.fromEntries(Object.values(resumed.operations).filter((op) => op.examples?.length).map((op) => [op.id, op.examples!]));
    source.examples = resumed.source.examples;
  } else if (args.examples) session.examples = recordExamples(args.examples, session.exampleTargets());
  else if (testsWanted()) session.examples = recordFromTests(session.graph(), session.exampleTargets());
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
  } else if (testsWanted()) {
    const review = reviewSummary(graph, diff);
    const recorded = recordFromTests({ ...graph, review }, headProject.operationTargets());
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
  const incomplete = analysisIssues(headProject, baseProject, diff, repo);
  if (incomplete.length) output.incomplete = incomplete;
}

describe(output, config);
{
  // Descriptions the profile has for nothing (a wrong key) would vanish without a word: say which.
  const unmatched = unmatchedDescriptions(config, Object.values(output.modules), headProject.knownOperations());
  if (unmatched.length) {
    output.source.profile = { ...(output.source.profile ?? { path: '', exists: true }), unmatched };
    console.warn(`profile: ${unmatched.length} description${unmatched.length > 1 ? 's describe' : ' describes'} nothing in this service (use the class name, as in the brief's JSON):`);
    for (const u of unmatched) console.warn(`  ${u}`);
  }
}

// ---------- write ----------
const briefFile = outFile.replace(/\.json$/, '') + '.brief.md';
/** Set once the review is done (deleted): nothing may write it back. */
let ended = false;
function write(graph: ModuleGraph): void {
  if (ended) return;
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
// Registry handlers (consumers, jobs) are entry points, not modules: a run with those profile rules counts fewer
// modules than one without, for the same code.
const registered = Object.values(output.entryPoints).filter((e) => e.kind === 'consumer' || e.kind === 'cron').length;
const counted = config.entryRegistries?.length && registered ? ` (handler classes the profile's entryRegistries list are counted as entry points, not modules)` : '';
console.log(`\n${config.service}: ${Object.keys(output.modules).length} modules, ${ops} operations${output.lazy ? ' analyzed' : ''}, ${Object.keys(output.entryPoints).length} entry points${counted} (${Date.now() - started} ms)`);
if (output.incomplete?.length) {
  // Before anything else: an incomplete analysis that reads like a clean one is how changes slip through.
  console.log('\nANALYSIS INCOMPLETE: what follows may be missing side effects, entry points or changes.');
  for (const line of issueLines(output.incomplete)) console.log(line);
}
if (base) {
  console.log(`change: ${r.stats.files} files, +${r.stats.linesAdded}/−${r.stats.linesRemoved}, ${r.stats.contractChanges} contract changes, ${r.stats.entryPointsAffected} entry points affected`);
  if (r.changes.length) console.log(`\nchanges (riskiest first): ${r.changes.length}, from ${r.queue.length} changed operations`);
  const why = new Map(r.queue.map((q) => [q.operation, q]));
  for (const c of r.changes) {
    console.log(`  [${c.risk.padEnd(6)}] ${opLabel(output, c.root).padEnd(40)} reach ${String(c.reach).padStart(2)}  ${why.get(c.root)!.reason}${c.alsoIn ? ` (also reached through ${c.alsoIn.map((x) => opLabel(output, x)).join(', ')})` : ''}`);
    for (const p of c.parts) console.log(`    └ [${why.get(p)!.risk.padEnd(6)}] ${opLabel(output, p).padEnd(36)} ${why.get(p)!.reason}`);
  }
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
// Short when it is below the folder the command ran in, else the full path: agents open it from anywhere.
const displayPath = (file: string) => (relative(userCwd, file).startsWith('..') ? file : relative(userCwd, file)).replace(/\\/g, '/');
console.log(`\nwrote ${displayPath(outFile)}`);
console.log(`wrote ${displayPath(briefFile)}   <- review facts for agents and people: start here`);

if (args.serve && session) {
  const live = session;
  let stateKey = currentStateKey();
  const idleMinutes = args.idle === undefined ? undefined : Number(args.idle);
  if (idleMinutes !== undefined && !(idleMinutes >= 0)) {
    console.error('--idle takes a number of minutes (0 = never stop by itself)');
    process.exit(2);
  }
  serve(live, {
    persist: write, graphId: id, port: Number(args.port ?? 5174), graphsDir, uiDir: uiDistDir, open: args.open, idleMinutes, repo,
    refresh: () => refresh(live), stale: () => currentStateKey() !== stateKey,
    // The UI's done button (and `modulegraph done`): delete this review's files, PR ref and scenario leftovers.
    done: ({ keepBrief }) => {
      ended = true;
      return endReview({ id, json: outFile, brief: briefFile, indexFile: args.out ? undefined : join(graphsDir, 'index.json') }, { keepBrief });
    },
  });

  /** Re-analyze after the code changed: re-read only changed files, keep the base side when it didn't move. */
  function refresh(s: LazySession): RefreshResult {
    const t = performance.now();
    const key = currentStateKey();
    const next = resolveRevisions();
    const reopen = (prev: RevisionAnalysis, files?: Map<string, string>) =>
      analyzer.reopen ? analyzer.reopen(prev, { repo, projectDir, config, files }) : { analysis: open(files), changedFiles: undefined };
    const head = next.headSha === headSha && headSha ? { analysis: headProject, changedFiles: [] as string[] } : reopen(headProject, next.headSha ? filesOf(next.headSha, headSha) : undefined);
    const base = !next.baseSha || !baseProject ? undefined : next.baseSha === revisions.baseSha ? { analysis: baseProject, changedFiles: [] as string[] } : reopen(baseProject, filesOf(next.baseSha, revisions.baseSha));
    const files = [...new Set([...(head.changedFiles ?? ['(all files)']), ...(base?.changedFiles ?? [])])].map((f) => relative(repo, f).replace(/\\/g, '/'));
    // The analysis fills in each file's modules, so compare what was read from git, not the filled-in copy.
    const meta = (x: Source) => JSON.stringify({ ...x, files: undefined, examples: undefined });
    const same = next.diff?.patch === diff?.patch && meta(next.source) === meta(source);
    stateKey = key;
    const served = () => {
      const g = s.graph();
      g.lazy!.api = '/api';
      return g;
    };
    // Descriptions the agent wrote into the profile since: re-read them (the rest of the profile needs a restart).
    const fresh = configFile ? loadConfig(projectDir, configFile) : undefined;
    const described = !!fresh && descriptionsKey(fresh) !== descriptionsKey(config);
    if (fresh) for (const [cls, o] of Object.entries(fresh.modules.overrides)) config.modules.overrides[cls] = { ...config.modules.overrides[cls], summary: o.summary, operations: o.operations };
    if (!files.length && same) {
      if (!described) return { changed: false, files: [], ms: Math.round(performance.now() - t), graph: served() };
      const graph = served();
      write(graph);
      console.log('refresh: descriptions re-read from the profile');
      return { changed: true, files: [relative(repo, configFile!).replace(/\\/g, '/')], baseKept: true, ms: Math.round(performance.now() - t), graph };
    }
    revisions = next;
    next.source.examples = source.examples;
    source = next.source;
    intent = next.intent;
    headSha = next.headSha;
    diff = next.diff;
    // Same text on a side (e.g. the fix was just committed): keep that side's analysis as it is.
    if (head.changedFiles?.length !== 0) headProject = head.analysis;
    if (base?.changedFiles?.length !== 0) baseProject = base?.analysis;
    s.refresh({ head: headProject, base: baseProject, diff, source, intent });
    // Examples run the code: record them again only when the code that runs changed.
    if (args.examples && files.length) s.examples = recordExamples(args.examples, s.exampleTargets());
    else if (files.length && testsWanted()) s.examples = recordFromTests(s.graph(), s.exampleTargets());
    const graph = served();
    write(graph);
    const ms = Math.round(performance.now() - t);
    console.log(`refresh: ${files.length} file${files.length === 1 ? '' : 's'} changed (${files.join(', ') || 'diff only'}), base ${base && base.analysis === baseProject && !base.changedFiles?.length ? 'kept' : 're-read'}, ${ms} ms`);
    return { changed: true, files, baseKept: !!base && !base.changedFiles?.length, ms, graph };
  }
}

/**
 * Analyzes again what the saved review had explored: the flows that were open, the callers that were loaded, the
 * modules drilled into. A saved full (not lazy) review had every flow analyzed.
 */
function resume(s: LazySession, saved: ModuleGraph): void {
  const t = performance.now();
  let n = 0;
  for (const e of Object.values(saved.entryPoints)) {
    if (e.change === 'removed' || (saved.lazy && e.analysis !== 'full')) continue;
    s.expand('entry', e.id);
    n++;
  }
  for (const op of Object.values(saved.operations)) {
    if (op.change === 'removed' || !op.lazy) continue;
    if (op.lazy.callersLoaded) (s.expand('callers', op.id), n++);
  }
  console.log(`resumed ${n} explored part${n === 1 ? '' : 's'} of the saved review (${Math.round(performance.now() - t)} ms)`);
}

/** Fingerprint of the code this review reads; changes when commits move or files in the checkout are edited. */
function currentStateKey(): string {
  const refs = [args.head, args.base, args.pr ? `refs/modulegraph/pr-${args.pr}` : undefined, 'HEAD'].filter((r): r is string => !!r);
  const head = args.head ?? (args.pr ? `refs/modulegraph/pr-${args.pr}` : 'HEAD');
  let checkedOut = !args.committed && !args.snapshot;
  try {
    checkedOut &&= revParse(repo, 'HEAD') === revParse(repo, head);
  } catch {
    checkedOut = false;
  }
  // The profile's descriptions count too: the agent writes them while the reviewer has the UI open.
  const profileText = configFile && existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  return `${workingStateKey(repo, refs, projectRel, checkedOut || args.snapshot === true)}
${profileText}`;
}

if (args.check && findings.some((f) => f.isNew && f.severity === 'error')) {
  console.error('\nmodulegraph check failed: the change introduces error-level findings');
  process.exit(1);
}
// A gate that passes because the analysis saw nothing is worse than no gate.
if (args.check && output.incomplete?.length && !args['allow-incomplete']) {
  console.error('\nmodulegraph check failed: the analysis is incomplete (see ANALYSIS INCOMPLETE above; --allow-incomplete to pass anyway)');
  process.exit(1);
}

/** A path as people read it: inside the modulegraph folder relative to it, under the home folder with `~`. */
function displayHome(path: string): string {
  const p = path.replace(/\\/g, '/');
  if (insideApp(p)) return relative(appRoot, p).replace(/\\/g, '/');
  const home = homedir().replace(/\\/g, '/');
  return p.toLowerCase().startsWith(`${home.toLowerCase()}/`) ? `~${p.slice(home.length)}` : p;
}

/** `modulegraph review …` that analyzes this review again, live: what a saved review tells you to run. */
function reviewCommand(s: Source): string {
  const q = (x: string) => (/[\s"'$`]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x);
  const project = insideApp(projectDir) ? relative(appRoot, projectDir).replace(/\\/g, '/') || '.' : projectDir;
  const mode = s.mode === 'snapshot' ? ['--snapshot']
    : s.mode === 'uncommitted' ? ['--uncommitted']
    : args.pr ? ['--pr', args.pr]
    : [...(args.head ? ['--head', args.head] : []), '--base', s.base ?? 'main'];
  const extra = [...(args.config ? ['--config', displayHome(fromUser(args.config))] : []), ...(args.committed ? ['--committed'] : []), ...(args.name ? ['--name', args.name] : [])];
  return ['modulegraph review --project', q(project), ...mode.map(q), ...extra.map(q)].join(' ');
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

/**
 * Examples from the service's own tests when there is no scenario: on by default (it runs the service's tests, as
 * `npm test` would), off for a PR unless `--tests` (it would run the PR's code), never for a snapshot.
 */
function testsWanted(): boolean {
  if (args['no-examples'] || args['no-tests'] || args.examples || source.mode === 'snapshot') return false;
  if (source.mode === 'pr' && !args.tests) {
    if (!testsWanted.said) console.log('examples: not running the tests of a PR (that runs its code on this machine); pass --tests to record examples from them');
    testsWanted.said = true;
    return false;
  }
  return !!jestConfigOf(projectDir);
}
testsWanted.said = false;

/** Runs the specs that reference the change with the service's Jest (head revision) and keeps what they recorded. */
function recordFromTests(g: Pick<ModuleGraph, 'operations' | 'modules' | 'scopes' | 'entryPoints' | 'review'>, targets: OperationTarget[]): Record<string, Example[]> {
  const names = changeNames(g);
  if (!names.classes.length && !names.stems.length) return {};
  const timeoutSeconds = Number(args['tests-timeout'] ?? 120);
  console.log(`examples: no scenario; running the service's tests that reference ${names.classes.slice(0, 4).join(', ')}${names.classes.length > 4 ? ', …' : ''} (jest, at most ${timeoutSeconds} s; --no-tests skips this)`);
  let result: TestExamplesResult | undefined;
  withHeadCode((codeRoot, tmp) => {
    result = recordTestExamples({ projectRoot: join(codeRoot, projectRel).replace(/\\/g, '/'), installedProject: projectDir, targets, codeRoot, names, tmp, timeoutSeconds });
  });
  const r = result!;
  // Jest's whole output next to the review: when nothing was recorded, the reason is in there.
  const logFile = outFile.replace(/\.json$/, '') + '.tests.log';
  if (r.log) {
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, r.log);
  }
  const note = r.note && r.log && !r.cases.length ? `${r.note} (Jest's output: ${logFile.replace(/\\/g, '/')})` : r.note;
  source.examples = {
    scenario: 'unit tests (mocked dependencies)',
    kind: 'tests',
    operationsCovered: Object.keys(r.examples).length,
    cases: r.cases,
    specs: r.specs,
    tests: r.tests,
    ...(r.timedOut ? { timedOut: true, timeoutSeconds } : {}),
    ...(note ? { note } : {}),
  };
  console.log(r.cases.length
    ? `examples: ${r.cases.length} test case${r.cases.length === 1 ? '' : 's'} recorded for ${Object.keys(r.examples).length} operations, from ${r.specs.length} spec file${r.specs.length === 1 ? '' : 's'} (${(r.ms / 1000).toFixed(1)} s)${r.timedOut ? `; stopped after ${timeoutSeconds} s, so some are missing` : ''}`
    : `examples: none recorded from tests: ${note}`);
  return r.examples;
}

/**
 * Runs `fn` with the head revision's code on disk: the checkout itself (the working tree, or the head commit when it
 * is checked out with no edits in the project), else a temporary git worktree of the head commit in
 * <repo>/.modulegraph-tmp/<pid>/, removed afterwards. The worktree gets links to the checkout's installed
 * `node_modules` folders (the project's and the ones above it), so modules resolve exactly as in the checkout:
 * nested copies first (`path-scurry/node_modules/lru-cache` 10 before a top-level `lru-cache` 5).
 */
function withHeadCode(fn: (codeRoot: string, tmp: string) => void): void {
  // One folder per process: several analyses (npm run live) may record examples at the same time.
  const tmp = join(repo, '.modulegraph-tmp', String(process.pid));
  mkdirSync(tmp, { recursive: true });
  let codeRoot = repo;
  let worktree: string | undefined;
  const links: string[] = [];
  try {
    const checkedOut = !!headSha && revParse(repo, 'HEAD') === headSha && !hasLocalChanges(repo, projectRel);
    if (headSha && !checkedOut) {
      worktree = join(tmp, `wt-${headSha.slice(0, 10)}`).replace(/\\/g, '/');
      if (existsSync(worktree)) git(repo, ['worktree', 'remove', '--force', worktree]);
      git(repo, ['worktree', 'add', '--detach', worktree, headSha]);
      codeRoot = worktree;
      links.push(...linkInstalledModules(repo, worktree, projectRel));
    }
    fn(codeRoot, tmp);
  } finally {
    // Unlink first: removing the worktree must never reach into the checkout's node_modules.
    for (const link of links) {
      try {
        unlinkSync(link);
      } catch {
        // already gone
      }
    }
    if (worktree) git(repo, ['worktree', 'remove', '--force', worktree]);
    rmSync(tmp, { recursive: true, force: true });
    // Leave no empty .modulegraph-tmp/ in the reviewed repo. rmdir only removes an empty folder: another run's
    // <pid> folder (npm run live records several at once) keeps it.
    try {
      rmdirSync(dirname(tmp));
    } catch {
      // not empty, or already gone
    }
  }
}

/**
 * Links (a junction on Windows) every installed `node_modules` of the checkout, from the project folder up to the
 * repo root, into the same place in a worktree of it. Returns the links, for removal.
 */
function linkInstalledModules(repoRoot: string, worktree: string, project: string): string[] {
  const out: string[] = [];
  const parts = project ? project.split('/').filter(Boolean) : [];
  for (let i = parts.length; i >= 0; i--) {
    const rel = parts.slice(0, i).join('/');
    const installed = join(repoRoot, rel, 'node_modules');
    const link = join(worktree, rel, 'node_modules');
    if (!existsSync(installed) || existsSync(link)) continue;
    try {
      symlinkSync(installed, link, 'junction');
      out.push(link);
    } catch (e) {
      console.warn(`examples: could not link ${installed.split('\\').join('/')} into the temporary worktree (${(e as Error).message})`);
    }
  }
  return out;
}

/** Runs the scenario against the head revision and returns the recorded calls per operation. */
function recordExamples(scenarioRel: string, targets: OperationTarget[]): Record<string, Example[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  let recorded: Record<string, Example[]> = {};
  withHeadCode((codeRoot, tmp) => {
    recorded = runScenario(here, scenarioRel, targets, codeRoot, tmp);
  });
  return recorded;
}

function runScenario(here: string, scenarioRel: string, targets: OperationTarget[], codeRoot: string, tmp: string): Record<string, Example[]> {
  {
    const scenario = fromUser(scenarioRel);
    if (!existsSync(scenario)) throw new Error(`scenario not found: ${scenarioRel}`);
    const projectRoot = join(codeRoot, projectRel).replace(/\\/g, '/');
    const out = join(tmp, 'examples.json');
    const spec = join(tmp, 'examples-spec.json');
    writeFileSync(spec, JSON.stringify({ scenario, projectRoot, out, tsconfig: join(projectRoot, config.tsconfig), targets: targets.map((t) => ({ ...t, file: join(codeRoot, t.file) })) }));
    // Compile the service with its own compiler options (decorators, for NestJS), not the analyzer's.
    const tsconfig = join(projectRoot, config.tsconfig);
    const env = existsSync(tsconfig) ? { ...process.env, TSX_TSCONFIG_PATH: tsconfig } : process.env;
    try {
      execFileSync(process.execPath, ['--import', 'tsx', join(here, 'examples-runner.ts'), spec], { cwd: resolve(here, '..'), stdio: 'inherit', env });
    } catch {
      console.warn(`examples: the scenario ${scenarioRel} failed (output above); continuing without example data`);
      return {};
    }
    const { examples: recorded, cases } = JSON.parse(readFileSync(out, 'utf8')) as { examples: Record<string, Example[]>; cases: ExampleCase[] };
    source.examples = { scenario: (insideApp(scenario) ? relative(appRoot, scenario) : scenario).replace(/\\/g, '/'), operationsCovered: Object.keys(recorded).length, cases };
    rmSync(out, { force: true });
    rmSync(spec, { force: true });
    return recorded;
  }
}
