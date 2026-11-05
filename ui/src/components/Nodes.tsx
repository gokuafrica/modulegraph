import { Handle, Position, type NodeProps } from '@xyflow/react';
import { createContext, useContext } from 'react';
import type { CodeChange, Effect, Example, Exit, Param } from '../../../schema/modulegraph.ts';
import type { Chip } from '../graph/model.ts';
import { FunctionDiff } from './DiffView.tsx';
import { exampleLabels, ObjectTree } from './ObjectTree.tsx';

export interface Actions {
  drill: (opId: string) => void;
  zoomOut: (opId: string) => void;
  /** Impact view of an operation, or of a whole module ("module:<id>"): who calls it, up to the entry points. */
  references: (target: string) => void;
  openEntry: (entryId: string) => void;
  expandGroup: (groupId: string) => void;
  /** Open the code-changes drawer for an operation or entry point. */
  showDiff: (id: string) => void;
  /** Lazy graphs: analyze one more level of callers of these operations. */
  loadCallers: (opIds: string[]) => Promise<void>;
}
export const ActionsContext = createContext<Actions>(null!);

/**
 * The example request every node shows: one request of the scenario, followed through every module it reached,
 * so the ids and data you see stay the same from the entry point down to the deepest module.
 */
export const ExampleContext = createContext<{ caseId?: string; setCase: (id: string) => void; cases: Record<string, string> }>({ setCase: () => {}, cases: {} });

/** The requests an example happened in. Graphs recorded before cases existed: one per example position. */
export function casesOf(e: Example, i: number): string[] {
  return e.cases ?? [`#${i}`];
}

/** The call this operation got in the given request, if the request reached it. */
export function exampleFor(examples: Example[] | undefined, caseId: string | undefined): Example | undefined {
  if (!examples?.length || !caseId) return undefined;
  return examples.find((e, i) => casesOf(e, i).includes(caseId));
}

/** The request's name, e.g. "POST /users/u-1/birth-info", for the case being shown. */
function caseName(cases: Record<string, string>, caseId: string | undefined): string | undefined {
  return caseId && !caseId.startsWith('#') ? cases[caseId] : undefined;
}

export function compact(value: unknown, max = 60): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line per top-level key of an example value, with fields added by this change highlighted. */
export function ExampleLines({ value, added }: { value: unknown; added?: Set<string> }) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      <>
        {Object.entries(value as Record<string, unknown>).slice(0, 9).map(([k, v]) => (
          <div key={k} className={`example-line ${added?.has(k) ? 'added' : ''}`} title={JSON.stringify(v, null, 2)}>
            {added?.has(k) ? '+' : ''}<span className="k">{k}:</span> <span className="v">{compact(v)}</span>
          </div>
        ))}
      </>
    );
  }
  return <div className="example-line" title={JSON.stringify(value, null, 2)}><span className="v">{compact(value)}</span></div>;
}

/** Request picker on the input end of a flow. Picking one switches every node in every view to that request. */
export function ExampleTabs({ examples }: { examples: Example[] }) {
  const { caseId, setCase, cases } = useContext(ExampleContext);
  if (examples.length < 2) return null;
  const labels = exampleLabels(examples.map((e) => e.input));
  return (
    <span className="example-tabs nodrag">
      {examples.map((ex, i) => {
        const ids = casesOf(ex, i);
        const names = ids.map((id) => cases[id]).filter(Boolean);
        return (
          <button key={i} className={caseId && ids.includes(caseId) ? 'on' : ''}
            title={names.length ? `${labels[i] ? `${labels[i]}: ` : ''}${names.slice(0, 6).join('\n')}${names.length > 6 ? `\n…and ${names.length - 6} more requests` : ''}` : `call ${i + 1}`}
            onClick={(e) => { e.stopPropagation(); setCase(ids[0]); }}>
            {i + 1}{labels[i] && <span className="tab-label"> {labels[i]}</span>}
          </button>
        );
      })}
    </span>
  );
}

/** One line of what this module got and returned in the request being followed. */
function ExampleLine({ examples }: { examples?: Example[] }) {
  const { caseId, cases } = useContext(ExampleContext);
  if (!examples?.length || !caseId) return null;
  const ex = exampleFor(examples, caseId);
  const name = caseName(cases, caseId) ?? 'this request';
  if (!ex) return <div className="node-example none" title={`Not called in ${name}`}>not called in this request</div>;
  const args = Object.values(ex.input);
  const input = args.length === 1 ? compact(args[0], 40) : compact(ex.input, 40);
  return (
    <div className="node-example" title={`${name}\n\nin: ${JSON.stringify(ex.input, null, 2)}\n\n${ex.error ? `throws: ${ex.error}` : `out: ${JSON.stringify(ex.output, null, 2)}`}`}>
      <div><span className="ex-tag">in</span>{input}</div>
      <div className={ex.error ? 'rejected' : ''}><span className="ex-tag">{ex.error ? (ex.status ? String(ex.status) : 'throws') : 'out'}</span>{ex.error ? compact(ex.error.replace(/^\w*Error: /, ''), 40) : compact(ex.output, 40)}</div>
    </div>
  );
}

/** "rejected · HTTP 422 · UnprocessableEntityException: …": what the caller got back. */
export function rejection(e: Example): string {
  return `${e.status ? `rejected · HTTP ${e.status} · ` : 'throws '}${e.error!.replace(/^Error: /, '')}`;
}

export const EFFECT_META: Record<Effect['kind'], { icon: string; label: string; cls: string }> = {
  'db.read': { icon: '⛁', label: 'DB read', cls: 'fx-read' },
  'db.write': { icon: '⛁', label: 'DB write', cls: 'fx-write' },
  outbox: { icon: '✉', label: 'outbox', cls: 'fx-outbox' },
  kafka: { icon: '⇶', label: 'Kafka', cls: 'fx-kafka' },
  http: { icon: '⇄', label: 'HTTP', cls: 'fx-http' },
  queue: { icon: '☰', label: 'queue', cls: 'fx-queue' },
  event: { icon: '⚡', label: 'in-process event', cls: 'fx-event' },
};

const KIND_META: Record<string, { icon: string; label: string; cls: string }> = {
  api: { icon: '⟶', label: 'REST', cls: 'k-api' },
  grpc: { icon: '⟶', label: 'gRPC', cls: 'k-grpc' },
  consumer: { icon: '⇶', label: 'Kafka consumer', cls: 'k-consumer' },
  cron: { icon: '⏱', label: 'cron', cls: 'k-cron' },
  queue: { icon: '☰', label: 'queue worker', cls: 'k-queue' },
  event: { icon: '⚡', label: 'event listener', cls: 'k-event' },
  input: { icon: '→', label: 'input', cls: 'k-input' },
};

const Handles = () => (
  <>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
  </>
);

export function EffectChip({ chip }: { chip: Chip }) {
  const meta = EFFECT_META[chip.kind];
  return (
    <span
      className={`chip ${meta.cls} ${chip.direct ? 'direct' : 'inherited'} ${chip.delta === '+' ? 'added' : chip.delta === '-' ? 'removed' : ''}`}
      title={`${chip.kind} ${chip.target}${chip.direct ? ' (this module)' : ' (via submodules)'}${chip.delta === '+' ? ': added by this change' : chip.delta === '-' ? ': removed by this change' : ''}`}
    >
      {chip.delta && <b>{chip.delta}</b>}
      <i>{meta.icon}</i>
      <span className="chip-kind">{meta.label}</span>
      <span className="chip-target">{chip.target}</span>
    </span>
  );
}

/**
 * What the change did to this step of the flow: a new call, or a removed one (a ghost now; "removes it" in the
 * before view). A changed condition isn't repeated here: the check node and its yes/no branches already show it.
 */
function StepDelta({ delta, conditionBefore, ghost, beforeMark, conditionNow }: { delta?: string; conditionBefore?: string; ghost?: boolean; beforeMark?: string; conditionNow?: string }) {
  if (beforeMark === 'removed') return <div className="step-delta del">− this change removes it</div>;
  if (ghost) return <div className="step-delta del">− removed by this change</div>;
  if (delta === 'added') return <div className="step-delta add">+ new call in this change</div>;
  return null;
}

/** "changes inside" only means something in a flow: it tells you which box to drill into. In the zoom-out
 *  view every node is there because it reaches the change, so the badge is suppressed. */
function ChangeBadge({ change, containsChanges }: { change: string; containsChanges?: boolean }) {
  if (change !== 'unchanged') return <span className={`badge b-${change}`}>{change}</span>;
  if (containsChanges) return <span className="badge b-inside" title="Something this module calls changed. Drill in.">changes inside</span>;
  return null;
}

export function ModuleNode({ data, selected }: NodeProps) {
  const d = data as {
    opId: string; title: string; operation: string; change: string; containsChanges: boolean; chips: Chip[];
    condition?: string; loop?: boolean; via?: string; through?: string; uses?: { opId: string; module: string; changed: boolean }[]; focus?: boolean; onPath?: boolean; hasInternals: boolean; reach?: number;
    compact?: boolean; inImpact?: boolean; totalEffects: number; ops?: string[]; opIds?: string[];
    delta?: string; conditionBefore?: string; ghost?: boolean; hasDiff?: boolean; stub?: boolean; partial?: boolean; reachPartial?: boolean;
    examples?: Example[]; transaction?: string;
    /** Impact view of a whole module: references go one level further up for the module, not one operation. */
    zoomTarget?: string;
    beforeMark?: string; conditionNow?: string;
  };
  const inside = d.containsChanges && !d.compact && !d.inImpact;
  const actions = useContext(ActionsContext);
  const extra = d.chips.length - 6;
  return (
    <div className={`node module ${d.compact ? 'compact' : ''} c-${d.change} ${inside ? 'has-changes' : ''} ${d.focus ? 'focus' : ''} ${d.onPath ? 'on-path' : ''} ${d.ghost ? 'ghost' : ''} ${d.delta === 'added' ? 'step-added' : ''} ${d.beforeMark === 'removed' ? 'step-removed' : ''} ${selected ? 'selected' : ''}`}>
      <Handles />
      {d.condition && <div className="cond" title={d.condition}>{d.condition}</div>}
      <StepDelta delta={d.delta} conditionBefore={d.conditionBefore} ghost={d.ghost} beforeMark={d.beforeMark} conditionNow={d.conditionNow} />
      <div className="module-head">
        <div>
          <div className="module-title">{d.title}{d.loop && <span className="loop" title="Runs once per item">⟳ each</span>}</div>
          {d.ops ? (
            <div className="module-op">
              {d.ops.map((name, i) => (
                <button key={name} className="link op-link nodrag" title="drill in" onClick={(e) => { e.stopPropagation(); actions.drill(d.opIds![i]); }}>.{name}()</button>
              ))}
            </div>
          ) : (
            <div className="module-op">.{d.operation}()</div>
          )}
        </div>
        <ChangeBadge change={d.change} containsChanges={inside} />
      </div>
      {d.via && <div className="via">inlined from {d.via}</div>}
      {d.through && <div className="via" title="Same-module wrapper, skipped (untick “skip pass-through wrappers” to see it)">through {d.through}()</div>}
      {!!d.uses?.length && (
        <div className="uses" title="Modules this one calls. Drill in to see how.">
          uses{' '}
          {d.uses.map((u, i) => (
            <span key={u.module}>
              {i > 0 && ' · '}
              <span className={u.changed ? 'use changed' : 'use'}>{u.module}</span>
            </span>
          ))}
        </div>
      )}
      <div className="chips">
        {d.chips.slice(0, 6).map((c) => <EffectChip key={`${c.kind}${c.target}${c.delta}`} chip={c} />)}
        {extra > 0 && <span className="chip more">+{extra} more</span>}
        {d.stub && <span className="pure">not analyzed yet: drill in to analyze</span>}
        {!d.stub && d.chips.length === 0 && !d.partial && (
          <span className="pure">{d.compact ? `${d.totalEffects} side effects, none changed` : 'no side effects'}</span>
        )}
        {d.partial && !d.compact && <span className="chip more" title="Some modules below this one are not analyzed yet. Drill in to analyze them.">+ ? below, not analyzed</span>}
      </div>
      {!d.compact && !d.ghost && <ExampleLine examples={d.examples} />}
      <div className="node-actions">
        {d.hasInternals || d.change !== 'unchanged' || d.stub || d.partial ? (
          <button className="link nodrag" onClick={(e) => { e.stopPropagation(); actions.drill(d.opId); }}>{d.stub ? 'analyze ⤵' : 'drill in ⤵'}</button>
        ) : <span />}
        {d.hasDiff && !d.ghost && (
          <button className="link nodrag diff-link" onClick={(e) => { e.stopPropagation(); actions.showDiff(d.opId); }} title="Code changes, function by function">diff ±</button>
        )}
        <button className="link nodrag" onClick={(e) => { e.stopPropagation(); actions.zoomOut(d.zoomTarget ?? d.opId); }}
          title={`Show references: everything that calls this, up to the ${d.reach ?? ''} entry points that reach it (impact view). Right-click for more.`}>
          references ⤴{d.reach !== undefined ? ` (${d.reachPartial ? '≥' : ''}${d.reach})` : ''}
        </button>
      </div>
    </div>
  );
}

export function EffectNode({ data, selected }: NodeProps) {
  const d = data as { effect: Effect; condition?: string; loop?: boolean; via?: string; delta?: string; conditionBefore?: string; ghost?: boolean; beforeMark?: string; conditionNow?: string; notes?: string[]; transaction?: string };
  const meta = EFFECT_META[d.effect.kind];
  return (
    <div className={`node effect ${meta.cls} ${d.ghost ? 'ghost' : ''} ${d.delta === 'added' ? 'step-added' : ''} ${d.beforeMark === 'removed' ? 'step-removed' : ''} ${selected ? 'selected' : ''}`}>
      <Handles />
      {d.condition && <div className="cond">{d.condition}</div>}
      <StepDelta delta={d.delta} conditionBefore={d.conditionBefore} ghost={d.ghost} beforeMark={d.beforeMark} conditionNow={d.conditionNow} />
      <div className="effect-who" title={`${d.effect.file ?? ''}:${d.effect.line ?? ''}`}>{FX_VERB[d.effect.kind]} directly, not through a module{d.loop && <span className="loop">⟳ each</span>}</div>
      <EffectChip chip={{ kind: d.effect.kind, target: d.effect.target, direct: true }} />
      {d.notes?.map((n) => <div key={n} className="effect-note">{n}</div>)}
    </div>
  );
}

/** What this module's own code does, for an effect step: "publishes" an event, "writes" a table. */
const FX_VERB: Record<Effect['kind'], string> = {
  'db.read': 'reads', 'db.write': 'writes', outbox: 'writes to the outbox', kafka: 'publishes', http: 'calls', queue: 'enqueues', event: 'emits',
};

export function EntryNode({ data, selected }: NodeProps) {
  const d = data as {
    kind: string; label: string; change: string; containsChanges?: boolean; readOnly?: boolean; effectsAdded?: Effect[];
    params?: Param[]; via?: string; entryId?: string; paramsDelta?: unknown; compact?: boolean;
    examples?: Example[]; exampleParams?: string[]; analysis?: string;
  };
  const { caseId, cases } = useContext(ExampleContext);
  const example = exampleFor(d.examples, caseId) ?? d.examples?.[0];
  const request = caseName(cases, caseId);
  const meta = KIND_META[d.kind] ?? KIND_META.input;
  const actions = useContext(ActionsContext);
  const writes = (d.effectsAdded ?? []).filter((e) => e.kind !== 'db.read' && e.kind !== 'http');
  return (
    <div className={`node entry ${meta.cls} c-${d.change} ${selected ? 'selected' : ''}`} onDoubleClick={() => d.entryId && actions.openEntry(d.entryId)}>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
      <div className="entry-kind">
        <span>{meta.icon} {meta.label}{d.readOnly ? ' · read-only' : ''}</span>
        <ChangeBadge change={d.change} containsChanges={d.containsChanges && !d.compact} />
      </div>
      <div className="entry-label">{d.label}</div>
      {d.kind === 'input' && d.params?.map((p) => <div className="param" key={p.name}>{p.name}: <span>{p.type}</span></div>)}
      {d.via && <div className="via">via {d.via}</div>}
      {d.compact && d.analysis === 'reached' && <div className="via" title="Known to reach the change; its flow is analyzed when you open it">flow not analyzed yet · double-click to open</div>}
      {example && (
        <div className="example">
          <div className="example-head"><span>example · input</span><ExampleTabs examples={d.examples!} /></div>
          {request && <div className="example-request" title={`Every module in every view shows what it got in this request`}>{request}</div>}
          <ObjectTree value={Object.fromEntries(d.exampleParams!.map((p) => [p, example.input[p]]))} flat />
        </div>
      )}
      {(d.effectsAdded?.length ?? 0) > 0 && (
        <div className={`entry-delta ${d.readOnly && writes.length ? 'warn' : ''}`} title={d.effectsAdded!.map((e) => `+${e.kind} ${e.target}`).join('\n')}>
          {d.change === 'added'
            ? `new entry point · ${d.effectsAdded!.length} side effects`
            : `+${d.effectsAdded!.slice(0, 3).map((e) => `${e.kind} ${e.target}`).join(', +')}${d.effectsAdded!.length > 3 ? ` +${d.effectsAdded!.length - 3} more` : ''}`}
        </div>
      )}
    </div>
  );
}

export function ExitNode({ data }: NodeProps) {
  const d = data as { label: string; type: string; fields: (Param & { delta?: string })[]; examples?: Example[] };
  const { caseId } = useContext(ExampleContext);
  const example = exampleFor(d.examples, caseId) ?? d.examples?.[0];
  const added = new Set(d.fields.filter((f) => f.delta === '+').map((f) => f.name));
  return (
    <div className="node exit">
      <Handle type="target" position={Position.Left} />
      <div className="entry-kind">⇥ {d.label}</div>
      {example && (
        <div className="example">
          <div className="example-head"><span>example · output</span></div>
          {example.error
            ? <div className="example-line rejected">{rejection(example)}</div>
            : <ObjectTree value={example.output} added={added} flat />}
        </div>
      )}
      {example && <div className="example-head" style={{ marginTop: 6 }}><span>shape</span></div>}
      <div className="exit-type" title={d.type}>{d.fields.length ? '' : d.type}</div>
      {d.fields.slice(0, 8).map((f) => (
        <div key={f.name} className={`param ${f.delta === '+' ? 'added' : f.delta === '-' ? 'removed' : ''}`}>
          {f.delta ?? ''}{f.name}: <span>{f.type}</span>
        </div>
      ))}
    </div>
  );
}

export function ResourceNode({ data }: NodeProps) {
  const d = data as { kind: 'table' | 'outbox' | 'topic' | 'service' | 'queue' | 'event'; target: string };
  const icon = { table: '⛁', outbox: '✉', topic: '⇶', service: '☁', queue: '☰', event: '⚡' }[d.kind];
  return (
    <div className={`node resource r-${d.kind}`}>
      <Handle type="target" position={Position.Left} />
      <span className="effect-icon">{icon}</span>
      <div>
        <div className="effect-kind">{d.kind}</div>
        <div className="effect-target">{d.target}</div>
      </div>
    </div>
  );
}

export function GroupNode({ data }: NodeProps) {
  const d = data as { groupId: string; label: string; kind: string; count: number; warn: number; changed: number };
  const actions = useContext(ActionsContext);
  const meta = KIND_META[d.kind];
  return (
    <div className={`node group ${meta.cls}`}>
      <Handle type="source" position={Position.Right} />
      <div className="entry-kind"><span>{meta.icon} {d.count} {meta.label} entry points</span></div>
      <div className="entry-label">{d.label}</div>
      <div className="group-foot">
        {d.warn > 0 && <span className="warn-text">⚠ {d.warn} read-only now write</span>}
        <button className="link nodrag" onClick={() => actions.expandGroup(d.groupId)}>expand ▸</button>
      </div>
    </div>
  );
}

/** Lazy graphs: callers above this node that have not been looked up yet. */
export function FrontierNode({ data }: NodeProps) {
  const d = data as { opIds: string[] };
  const actions = useContext(ActionsContext);
  return (
    <div className="node frontier" title="Callers of this module are not analyzed yet">
      <Handle type="source" position={Position.Right} />
      <span className="muted">⋯ callers not loaded</span>
      <button className="link nodrag" onClick={(e) => { e.stopPropagation(); void actions.loadCallers(d.opIds); }}>load ⤴</button>
    </div>
  );
}

export function DecisionNode({ data }: NodeProps) {
  const d = data as { label: string; added?: boolean };
  return (
    <div className={`node decision ${d.added ? 'added' : ''}`} title="A check in the code: what follows runs on one side only">
      <Handles />
      {d.added && <div className="step-delta add">+ new check in this change</div>}
      <div className="decision-row">
        <span className="decision-icon">◇</span>
        <span className="decision-label">{d.label}</span>
      </div>
    </div>
  );
}

/** Where an early `throw` / `return` ends the flow: the other side of a check. */
export function StopNode({ data }: NodeProps) {
  const d = data as { exit: Exit; status?: number; examples?: Example[] };
  const { caseId } = useContext(ExampleContext);
  // Following a request that ended here: say so.
  const ex = exampleFor(d.examples, caseId);
  const here = !!ex?.error && (!d.exit.what || ex.error.includes(d.exit.what));
  const throws = d.exit.kind === 'throw';
  return (
    <div className={`node stop ${throws ? 'throws' : 'returns'} ${d.exit.delta ? 'step-added' : ''} ${here ? 'hit' : ''}`}
      title={`${d.exit.file}:${d.exit.line}${here ? '\nThe request being followed ends here.' : ''}`}>
      <Handle type="target" position={Position.Left} />
      {d.exit.delta && <div className="step-delta add">+ new in this change</div>}
      <div className="entry-kind">{throws ? '⛔ rejects the request' : '↩ returns early'}{d.status ? <span className="status">HTTP {d.status}</span> : null}</div>
      <div className="stop-what">{throws ? `throws ${d.exit.what ?? 'an error'}` : `returns ${d.exit.what ?? 'nothing'}`}</div>
      {d.exit.message && <div className="stop-msg">“{d.exit.message}”</div>}
      {here && <div className="stop-here">this request ends here</div>}
    </div>
  );
}

/** Leaf of the drill-in: no submodules or side effects left, only code. Changed code is summarised per function. */
export function CodeNode({ data }: NodeProps) {
  const d = data as { opId: string; source: string; changes: CodeChange[]; before?: boolean };
  const actions = useContext(ActionsContext);
  if (!d.changes.length) {
    return (
      <div className="node code nowheel">
        <Handles />
        <div className="entry-kind">{d.before ? 'internal logic before this change' : 'internal logic: no submodules or side effects'}</div>
        <pre>{d.source.split('\n').map((l, i) => <div key={i} className="dl dl-ctx">{l}</div>)}</pre>
      </div>
    );
  }
  const files = new Set(d.changes.map((c) => c.file)).size;
  const n = `${d.changes.length} function${d.changes.length > 1 ? 's' : ''}${files > 1 ? ` in ${files} files` : ''}`;
  const allNew = d.changes.every((c) => c.status === 'added');
  return (
    <div className="node code nowheel">
      <Handles />
      <div className="entry-kind code-head">
        <span title={allNew ? 'All of this code is new: every line is an added line' : undefined}>{allNew ? `new code: ${n}, every line new` : `internal logic changed: ${n}`}</span>
        <button className="link nodrag" onClick={(e) => { e.stopPropagation(); actions.showDiff(d.opId); }}>open diff ▸</button>
      </div>
      <div className="code-scroll">
        {d.changes.map((c) => <FunctionDiff key={`${c.file}:${c.name}`} change={c} compact />)}
      </div>
    </div>
  );
}

/** A transaction the code opens: everything drawn inside commits together or not at all. */
export function TxGroupNode({ data }: NodeProps) {
  const d = data as { label: string; count: number };
  return (
    <div className="txgroup" title={`The code opens ${d.label} here: the ${d.count} steps inside commit together or roll back together`}>
      <span className="tx-label">⛓ one transaction</span> <span className="tx-what">{d.label}</span>
    </div>
  );
}

export const nodeTypes = {
  txgroup: TxGroupNode,
  module: ModuleNode,
  effect: EffectNode,
  entry: EntryNode,
  exit: ExitNode,
  resource: ResourceNode,
  entrygroup: GroupNode,
  code: CodeNode,
  decision: DecisionNode,
  stop: StopNode,
  frontier: FrontierNode,
};
