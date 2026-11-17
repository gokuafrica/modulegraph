/**
 * Runs the CLI the way an agent does on a realistic service with no profile (sample-legacy-nest-service, branch
 * fix/scope-manual-data-to-row) and checks what the review says:
 *   - examples recorded from the service's own Jest specs (no scenario), marked as coming from tests;
 *   - an INCOMPLETE verdict that names the missing consumers and jobs and the exact profile rules to add;
 *   - descriptions from @ApiOperation and class doc comments, and "Needs a description" only for what has none;
 *   - nothing left behind in the repo (temporary worktree, .modulegraph-tmp).
 * usage: npm run legacy-review-check --workspace analyzer
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { git } from './git.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..').replace(/\\/g, '/');
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

const tmp = mkdtempSync(join(tmpdir(), 'mg-legacy-'));
try {
  const out = join(tmp, 'review.json');
  console.log('\nsample-legacy-nest-service fix/scope-manual-data-to-row, no profile (lazy, as the module-review skill runs it)');
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'cli.ts'), '--project', join(repo, 'sample-legacy-nest-service'), '--head', 'fix/scope-manual-data-to-row', '--lazy', '--out', out], {
    cwd: join(repo, 'analyzer'),
    stdio: ['ignore', 'pipe', 'inherit'],
    // No user profile may change what a first run looks like.
    env: { ...process.env, MODULEGRAPH_HOME: join(tmp, 'home') },
  });
  const g = JSON.parse(readFileSync(out, 'utf8')) as ModuleGraph;
  const brief = readFileSync(out.replace(/\.json$/, '.brief.md'), 'utf8');

  // F2 / R2-1: examples from the tests, in the temporary worktree of the head (node_modules linked in: lru-cache 5 on
  // top, path-scurry's own 10 nested; an absolute moduleDirectories entry broke every suite)
  const ex = g.source.examples;
  if (ex?.kind !== 'tests') fail(`examples: kind ${ex?.kind}, expected tests`);
  else {
    const specs = ex.specs ?? [];
    if (!ex.tests) fail(`examples: Tests: 0 total (${ex.note ?? 'no note'})`);
    for (const s of ['src/manual-review/services/conclude-manual-review-decision-service.spec.ts', 'src/manual-review/services/manual-review.service.spec.ts', 'src/consumers/handlers/user-record-data-updated.handler.spec.ts', 'src/escalations/services/escalations.service.spec.ts']) if (!specs.includes(s)) fail(`examples: ${s} did not run (ran ${specs.join(', ')})`);
    if (specs.some((s) => /comments|transformer/.test(s))) fail(`examples: specs that don't reference the change ran: ${specs.join(', ')}`);
    for (const op of ['ConcludeManualReviewDecisionService.approve', 'ConcludeManualReviewDecisionService.correctData', 'ManualReviewService.approveUserRecord', 'EscalationsService.resolve', 'UserRecordDataUpdatedHandler.handleMessages']) if (!g.operations[op]?.examples?.length) fail(`examples: ${op} has none`);
    const approve = g.operations['ConcludeManualReviewDecisionService.approve']?.examples ?? [];
    if (!approve.some((e) => e.error?.includes('NotFoundException')) || !approve.some((e) => (e.output as { status?: string } | undefined)?.status === 'APPROVED')) fail('examples: approve lacks the approved and the not-found cases');
    if (!(ex.cases ?? []).every((c) => /\.spec\.ts › /.test(c.label))) fail('examples: case labels do not name their spec');
    if (!/Example data: \d+ test cases recorded \*\*from unit tests \(mocked dependencies\)\*\*/.test(brief)) fail('brief: no example-data line');
    if (!failures) ok(`${ex.cases?.length} test cases (${ex.tests} tests) from ${specs.length} spec files in a worktree of the head, marked as from unit tests`);
  }

  // F5 / R2-3 / R2-4 / R2-5 / R2-8: incomplete, with rules that work
  const kinds = (g.incomplete ?? []).map((i) => i.kind);
  if (!kinds.includes('missing-entry-points') || !kinds.includes('unknown-side-effects')) fail(`incomplete: ${kinds.join(', ') || 'none'}`);
  for (const text of [
    '**Verdict: INCOMPLETE analysis, not a pass.**',
    '"entryRegistries": [',
    // the method is inherited by 5 handlers and abstract on the base: found through the base classes
    '{ "map": "ConsumerHandlerMap", "method": "handleMessages", "kind": "consumer", "label": "kafka consumer {key}" }',
    'consumersManager.addHandler(this)',
    '{ "argv": "src/main.ts", "kind": "cron", "label": "job {key}" }',
    // the topic is a property of the record argument; the outbox call is suggested too
    '{ "class": "AcmeAvroProducer", "module": "@acme/nestjs-kafkajs", "method": "send", "kind": "kafka", "target": "arg:0.topic" }',
    '{ "class": "TypeORMOutboxService", "module": "@acme/typeorm-outbox-writer", "method": "createOutboxMessage", "kind": "outbox", "target": "arg:0" }',
    '{ "class": "OutboxWriter", "module": "@acme/typeorm-outbox-writer", "method": "write", "kind": "outbox", "target": "arg:1" }',
  ]) {
    if (!brief.includes(text)) fail(`brief lacks: ${text}`);
  }
  const incompleteText = brief.split('## Analysis incomplete')[1]?.split('Stated intent')[0] ?? '';
  // a factory is not a send; a type-only import runs nothing; a developer script is not the service
  for (const [bad, why] of [['"method": "producer"', 'the producer() factory suggested as a sink'], ['const:nestjs-kafkajs', 'a package name as a topic'], ['@nestjs/microservices', 'a type-only import counted'], ['.local/', 'a developer script counted'], ['start:consumers', 'the consumer-selecting script taken for a job']] as const) {
    if (incompleteText.includes(bad)) fail(`brief: ${why} (${bad})`);
  }
  if (!failures) ok('INCOMPLETE: the handler map with its inherited handleMessages, the jobs, the producer (arg:0.topic) and the outbox calls, without factories, type-only imports or developer scripts');

  // F3 / R2-9: descriptions
  const facade = g.operations['ManualReviewService.approveUserRecord'];
  if (facade?.summarySource !== 'api' || !/^@ApiOperation on PUT \/api\/v1\/internal\/manual-review\/approve\/:guid$/.test(facade.summaryFrom ?? '')) fail(`approveUserRecord description: ${facade?.summarySource} ${facade?.summaryFrom}`);
  const worker = g.operations['ConcludeManualReviewDecisionService.approve'];
  if (worker?.summary || worker?.context?.from !== 'ManualReviewService.approveUserRecord') fail(`worker: summary ${worker?.summarySource ?? 'none'}, context ${JSON.stringify(worker?.context)}`);
  const needs = brief.split('## Needs a description')[1]?.split('\n## ')[0] ?? '';
  if (!needs.includes('`KmsService.encryptString`')) fail('Needs a description: KmsService.encryptString (no docs) is not listed');
  if (/^- `ManualReviewService\.approveUserRecord`/m.test(needs) || /^- `UserRecordDataTransformer\.normalize`/m.test(needs)) fail('Needs a description lists operations that have a description (API docs, class comment)');
  if (!/^- `ConcludeManualReviewDecisionService\.approve` .*only called through `ManualReviewService\.approveUserRecord`/m.test(needs)) fail('Required: the worker lacks the facade context');
  if (!needs.includes('"ConcludeManualReviewDecisionService": { "operations": { "approve": "…", "correctData": "…" } }')) fail('Needs a description: no exact JSON for both required operations');
  if (!failures) ok('descriptions: @ApiOperation on the facade; the worker behind it is required, with the facade\'s text as context and the exact JSON');

  // Owners from the project's CODEOWNERS
  if (!g.review.reviewers.some((r) => r.includes('@acme/manual-review-squad'))) fail(`owners: ${g.review.reviewers.join(', ') || 'none'}`);

  // Nothing left in the repo
  if (existsSync(join(repo, '.modulegraph-tmp'))) fail('.modulegraph-tmp left in the repo');
  if (git(repo, ['worktree', 'list']).includes('.modulegraph-tmp')) fail('a temporary worktree is still registered');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} problem(s) in the review of the realistic sample` : '\nthe realistic sample gets examples from its tests, an honest INCOMPLETE with the rules to add, and its API docs as descriptions');
process.exit(failures ? 1 : 0);
