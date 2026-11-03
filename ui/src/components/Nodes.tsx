import { Handle, Position, type NodeProps } from '@xyflow/react';
import { createContext, useContext } from 'react';
import type { DiffLine, Effect, Example, Param } from '../../../schema/modulegraph.ts';
import type { Chip } from '../graph/model.ts';

export interface Actions {
  drill: (opId: string) => void;
  zoomOut: (opId: string) => void;
  openEntry: (entryId: string) => void;
  expandGroup: (groupId: string) => void;
}
export const ActionsContext = createContext<Actions>(null!);

/** Which recorded example the input and output nodes show; shared so both ends of a flow stay in sync. */
export const ExampleContext = createContext<{ index: number; setIndex: (i: number) => void }>({ index: 0, setIndex: () => {} });

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

function ExampleTabs({ examples }: { examples: Example[] }) {
  const { index, setIndex } = useContext(ExampleContext);
  if (examples.length < 2) return null;
  return (
    <span className="example-tabs nodrag">
      {examples.map((_, i) => (
        <button key={i} className={i === index % examples.length ? 'on' : ''} onClick={(e) => { e.stopPropagation(); setIndex(i); }}>{i + 1}</button>
      ))}
    </span>
  );
}

export const EFFECT_META: Record<Effect['kind'], { icon: string; label: string; cls: string }> = {
  'db.read': { icon: '⛁', label: 'read', cls: 'fx-read' },
  'db.write': { icon: '⛁', label: 'write', cls: 'fx-write' },
  outbox: { icon: '✉', label: 'outbox', cls: 'fx-outbox' },
  kafka: { icon: '⇶', label: 'kafka', cls: 'fx-kafka' },
  http: { icon: '⇄', label: 'http', cls: 'fx-http' },
};

const KIND_META: Record<string, { icon: string; label: string; cls: string }> = {
  api: { icon: '⟶', label: 'REST', cls: 'k-api' },
  grpc: { icon: '⟶', label: 'gRPC', cls: 'k-grpc' },
  consumer: { icon: '⇶', label: 'Kafka consumer', cls: 'k-consumer' },
  cron: { icon: '⏱', label: 'cron', cls: 'k-cron' },
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
    condition?: string; loop?: boolean; via?: string; focus?: boolean; onPath?: boolean; hasInternals: boolean; reach?: number;
    compact?: boolean; inImpact?: boolean; totalEffects: number; ops?: string[]; opIds?: string[];
  };
  const inside = d.containsChanges && !d.compact && !d.inImpact;
  const actions = useContext(ActionsContext);
  const extra = d.chips.length - 6;
  return (
    <div className={`node module ${d.compact ? 'compact' : ''} c-${d.change} ${inside ? 'has-changes' : ''} ${d.focus ? 'focus' : ''} ${d.onPath ? 'on-path' : ''} ${selected ? 'selected' : ''}`}>
      <Handles />
      {d.condition && <div className="cond" title={d.condition}>{d.condition}</div>}
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
      <div className="chips">
        {d.chips.slice(0, 6).map((c) => <EffectChip key={`${c.kind}${c.target}${c.delta}`} chip={c} />)}
        {extra > 0 && <span className="chip more">+{extra} more</span>}
        {d.chips.length === 0 && (
          <span className="pure">{d.compact ? `${d.totalEffects} side effects, none changed` : 'no side effects'}</span>
        )}
      </div>
      <div className="node-actions">
        {d.hasInternals || d.change !== 'unchanged' ? (
          <button className="link nodrag" onClick={(e) => { e.stopPropagation(); actions.drill(d.opId); }}>drill in ⤵</button>
        ) : <span />}
        <button className="link nodrag" onClick={(e) => { e.stopPropagation(); actions.zoomOut(d.opId); }}>
          zoom out ⤴{d.reach !== undefined ? ` (${d.reach})` : ''}
        </button>
      </div>
    </div>
  );
}

export function EffectNode({ data, selected }: NodeProps) {
  const d = data as { effect: Effect; condition?: string; loop?: boolean; via?: string };
  const meta = EFFECT_META[d.effect.kind];
  return (
    <div className={`node effect ${meta.cls} ${selected ? 'selected' : ''}`}>
      <Handles />
      {d.condition && <div className="cond">{d.condition}</div>}
      <div className="effect-body">
        <span className="effect-icon">{meta.icon}</span>
        <div>
          <div className="effect-kind">{d.effect.kind}{d.loop && <span className="loop">⟳ each</span>}</div>
          <div className="effect-target">{d.effect.target}</div>
        </div>
      </div>
    </div>
  );
}

export function EntryNode({ data, selected }: NodeProps) {
  const d = data as {
    kind: string; label: string; change: string; containsChanges?: boolean; readOnly?: boolean; effectsAdded?: Effect[];
    params?: Param[]; via?: string; entryId?: string; paramsDelta?: unknown; compact?: boolean;
    examples?: Example[]; exampleParams?: string[];
  };
  const { index } = useContext(ExampleContext);
  const example = d.examples?.length ? d.examples[index % d.examples.length] : undefined;
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
      {example && (
        <div className="example">
          <div className="example-head"><span>e.g. input</span><ExampleTabs examples={d.examples!} /></div>
          {d.exampleParams!.map((p) => (
            <div key={p} className="example-line" title={JSON.stringify(example.input[p], null, 2)}>
              <span className="k">{p}:</span> <span className="v">{compact(example.input[p], 44)}</span>
            </div>
          ))}
        </div>
      )}
      {(d.effectsAdded?.length ?? 0) > 0 && (
        <div className={`entry-delta ${d.readOnly && writes.length ? 'warn' : ''}`}>
          +{d.effectsAdded!.map((e) => `${e.kind} ${e.target}`).join(', +')}
        </div>
      )}
    </div>
  );
}

export function ExitNode({ data }: NodeProps) {
  const d = data as { label: string; type: string; fields: (Param & { delta?: string })[]; examples?: Example[] };
  const { index } = useContext(ExampleContext);
  const example = d.examples?.length ? d.examples[index % d.examples.length] : undefined;
  const added = new Set(d.fields.filter((f) => f.delta === '+').map((f) => f.name));
  return (
    <div className="node exit">
      <Handle type="target" position={Position.Left} />
      <div className="entry-kind">⇥ {d.label}</div>
      {example && (
        <div className="example">
          <div className="example-head"><span>e.g. output{d.examples!.length > 1 ? ` · call ${(index % d.examples!.length) + 1}` : ''}</span><ExampleTabs examples={d.examples!} /></div>
          {example.error ? <div className="example-line"><span className="v">throws {compact(example.error)}</span></div> : <ExampleLines value={example.output} added={added} />}
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
  const d = data as { kind: 'table' | 'outbox' | 'topic' | 'service'; target: string };
  const icon = { table: '⛁', outbox: '✉', topic: '⇶', service: '☁' }[d.kind];
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

export function DecisionNode({ data }: NodeProps) {
  const d = data as { label: string };
  return (
    <div className="node decision" title="Exclusive branch: exactly one side runs">
      <Handles />
      <span className="decision-icon">◇</span>
      <span className="decision-label">{d.label}</span>
    </div>
  );
}

export function CodeNode({ data }: NodeProps) {
  const d = data as { source: string; diff?: DiffLine[] };
  const lines = d.diff ?? d.source.split('\n').map((text) => ({ t: ' ', text }) as DiffLine);
  return (
    <div className="node code nowheel">
      <Handles />
      <div className="entry-kind">internal logic: no submodules or side effects</div>
      <pre>
        {lines.map((l, i) => <div key={i} className={`dl dl-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>{l.t} {l.text}</div>)}
      </pre>
    </div>
  );
}

export const nodeTypes = {
  module: ModuleNode,
  effect: EffectNode,
  entry: EntryNode,
  exit: ExitNode,
  resource: ResourceNode,
  entrygroup: GroupNode,
  code: CodeNode,
  decision: DecisionNode,
};
