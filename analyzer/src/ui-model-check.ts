/**
 * Checks what the UI draws, from its own model code (ui/src/graph/model.ts), on a real review: the realistic
 * NestJS sample's branch fix/scope-manual-data-to-row.
 *   - impact view: a caller whose side effects all come through a submodule, none of them changed, still counts
 *     them ("3 side effects, none changed", not "0");
 *   - flow view: a global interceptor's steps (metrics) are one folded "request pipeline" node, and the endpoint's
 *     business module comes first; unfolded they are all there again.
 * usage: npm run ui-model-check --workspace analyzer
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { buildIndex, effectCount, flowModel, impactModel, PIPELINE_NODE } from '../../ui/src/graph/model.ts';
import { typescript } from './analyzers/typescript/index.ts';
import { compare } from './compare.ts';
import { loadConfig } from './config.ts';
import { describe } from './describe.ts';
import { diffBetween, filesAtRef, mergeBase, revParse } from './git.ts';
import { reviewSummary } from './rules.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..').replace(/\\/g, '/');
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};

const projectRel = 'sample-legacy-nest-service';
const branch = 'fix/scope-manual-data-to-row';
const projectDir = join(repo, projectRel).replace(/\\/g, '/');
const config = loadConfig(projectDir);
const mb = mergeBase(repo, 'main', branch);
const head = typescript.open({ repo, projectDir, config, files: filesAtRef(repo, revParse(repo, branch), projectRel) }).run();
const base = typescript.open({ repo, projectDir, config, files: filesAtRef(repo, mb, projectRel) }).run();
const diff = diffBetween(repo, mb, branch, projectRel);
const graph = describe(compare(head, base), config);
const g = { ...graph, review: reviewSummary(graph, diff), findings: [], schema: 'modulegraph/v1', service: config.service, generatedAt: '', generator: 'check', source: { mode: 'branch', repo: '.', project: projectRel, files: diff.files } } as ModuleGraph;
const index = buildIndex(g);

console.log(`\n${projectRel} ${branch}: impact view`);
{
  // UserRecordDataUpdatedHandler.handle reaches the changed updateUserRecordData; all its effects come through it.
  const model = impactModel(g, index, 'ManualReviewService.updateUserRecordData', { depth: 1, groupThreshold: 12, expandedGroups: new Set() });
  const node = model.nodes.find((n) => n.id === 'mod:UserRecordDataUpdatedHandler');
  if (!node) fail('the Kafka handler is not drawn as a caller of updateUserRecordData');
  else {
    const want = effectCount(g, ['UserRecordDataUpdatedHandler.handle']);
    const d = node.data as { totalEffects: number; chips: unknown[] };
    if (want === 0) fail('the handler has no side effects through its submodule: the sample changed?');
    if (d.totalEffects !== want) fail(`handler node counts ${d.totalEffects} side effects, not ${want} (the ones it has through ManualReview)`);
    if (d.chips.length) fail(`handler node shows ${d.chips.length} chips; only what the change did to its effects (nothing) should be drawn`);
    console.log(`  caller UserRecordDataUpdatedHandler: "${d.totalEffects} side effects, none changed"`);
  }
  // A caller with direct effects as well: EscalationsService.resolve → approve.
  const m2 = impactModel(g, index, 'ManualReviewService.approve', { depth: 1, groupThreshold: 12, expandedGroups: new Set() });
  const esc = m2.nodes.find((n) => n.id === 'mod:EscalationsService')?.data as { totalEffects: number } | undefined;
  if (!esc || esc.totalEffects !== effectCount(g, ['EscalationsService.resolve'])) fail(`EscalationsService caller counts ${esc?.totalEffects} side effects, not ${effectCount(g, ['EscalationsService.resolve'])}`);
}

console.log(`\n${projectRel} ${branch}: flow view`);
{
  const entry = 'api:PUT /api/v1/internal/manual-review/approve/:guid';
  const opts = { collapsePassthrough: true, showResources: false };
  const folded = flowModel(g, entry, opts);
  const pipelineNodes = folded.nodes.filter((n) => n.type === 'pipeline');
  const modules = folded.nodes.filter((n) => n.type === 'module').map((n) => (n.data as { title: string }).title);
  if (pipelineNodes.length !== 1 || pipelineNodes[0].id !== PIPELINE_NODE) fail(`expected one folded request pipeline node, got ${pipelineNodes.length}`);
  if (modules.some((m) => /Metrics|RequestContext/.test(m))) fail(`folded flow still draws pipeline modules: ${modules.join(', ')}`);
  if (JSON.stringify(modules) !== JSON.stringify(['ManualReview'])) fail(`business modules of the flow: ${modules.join(', ')} ≠ ManualReview`);
  const items = (pipelineNodes[0]?.data as { items?: string[] })?.items ?? [];
  if (!items.includes('interceptor RequestTimer')) fail(`pipeline node items: ${items.join(', ')}`);
  console.log(`  folded: ${modules.join(', ')} + 1 pipeline node (${items.join(' · ')}, ${folded.pipelineSteps} steps)`);
  const shown = flowModel(g, entry, { ...opts, showPipeline: true });
  const metrics = shown.nodes.filter((n) => n.type === 'module' && (n.data as { title: string }).title === 'Metrics').length;
  if (shown.nodes.some((n) => n.type === 'pipeline') || metrics < 4) fail(`unfolded: ${metrics} Metrics steps and ${shown.nodes.filter((n) => n.type === 'pipeline').length} pipeline nodes`);
  console.log(`  unfolded: ${metrics} Metrics steps`);
}

console.log(failures ? `\n${failures} UI model mismatch(es)` : '\nUI model: impact counts and the folded pipeline are right');
process.exit(failures ? 1 : 0);
