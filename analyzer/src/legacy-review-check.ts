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

  // F2: examples from the tests
  const ex = g.source.examples;
  if (ex?.kind !== 'tests') fail(`examples: kind ${ex?.kind}, expected tests`);
  else {
    const specs = ex.specs ?? [];
    for (const s of ['src/manual-review/services/manual-review.service.spec.ts', 'src/consumers/handlers/user-record-data-updated.handler.spec.ts', 'src/escalations/services/escalations.service.spec.ts']) if (!specs.includes(s)) fail(`examples: ${s} did not run (ran ${specs.join(', ')})`);
    if (specs.some((s) => /comments|transformer/.test(s))) fail(`examples: specs that don't reference the change ran: ${specs.join(', ')}`);
    for (const op of ['ManualReviewService.approve', 'ManualReviewService.updateUserRecordData', 'EscalationsService.resolve', 'UserRecordDataUpdatedHandler.handle']) if (!g.operations[op]?.examples?.length) fail(`examples: ${op} has none`);
    const approve = g.operations['ManualReviewService.approve']?.examples ?? [];
    if (!approve.some((e) => e.error?.includes('NotFoundException')) || !approve.some((e) => (e.output as { status?: string } | undefined)?.status === 'APPROVED')) fail('examples: approve lacks the approved and the not-found cases');
    if (!(ex.cases ?? []).every((c) => /\.spec\.ts › /.test(c.label))) fail('examples: case labels do not name their spec');
    if (!/Example data: \d+ test cases recorded \*\*from unit tests \(mocked dependencies\)\*\*/.test(brief)) fail('brief: no example-data line');
    if (!failures) ok(`${ex.cases?.length} test cases from ${specs.length} spec files, marked as from unit tests`);
  }

  // F5: incomplete, with the rules
  const kinds = (g.incomplete ?? []).map((i) => i.kind);
  if (!kinds.includes('missing-entry-points') || !kinds.includes('unknown-side-effects')) fail(`incomplete: ${kinds.join(', ') || 'none'}`);
  for (const text of ['**Verdict: INCOMPLETE analysis, not a pass.**', '"entryRegistries": [', '{ "map": "ConsumerHandlerMap", "method": "handle", "kind": "consumer", "label": "kafka consumer {key}" }', '{ "argv": "src/main.ts", "kind": "cron", "label": "job {key}" }', '{ "class": "AvroProducer", "module": "@acme/nestjs-kafkajs", "method": "send", "kind": "kafka", "target": "arg:0" }', '{ "class": "OutboxWriter", "module": "@acme/typeorm-outbox-writer", "method": "write", "kind": "outbox", "target": "arg:1" }']) {
    if (!brief.includes(text)) fail(`brief lacks: ${text}`);
  }
  if (!failures) ok('INCOMPLETE: missing consumers and jobs, unknown producer/outbox packages, with the profile rules to add');

  // F3: descriptions
  const approveOp = g.operations['ManualReviewService.approve'];
  if (approveOp?.summarySource !== 'api' || !/^@ApiOperation on PUT \/api\/v1\/internal\/manual-review\/approve\/:guid$/.test(approveOp.summaryFrom ?? '')) fail(`approve description: ${approveOp?.summarySource} ${approveOp?.summaryFrom}`);
  const needs = brief.split('## Needs a description')[1]?.split('\n## ')[0] ?? '';
  if (!needs.includes('`KmsService.encryptString`')) fail('Needs a description: KmsService.encryptString (no docs) is not listed');
  if (/^- `ManualReviewService\.approve`/m.test(needs) || /^- `UserRecordDataTransformer\.normalize`/m.test(needs)) fail('Needs a description lists operations that have a description (API docs, class comment)');
  if (!needs.includes('(@ApiOperation on PUT /api/v1/internal/manual-review/approve/:guid)')) fail('Needs a description does not say approve is described from @ApiOperation');
  if (!failures) ok('descriptions from @ApiOperation and class comments; only undocumented operations need one');

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
