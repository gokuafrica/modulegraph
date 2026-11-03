import { useContext, useState } from 'react';
import type { Effect, Finding, ModuleGraph, Operation } from '../../../schema/modulegraph.ts';
import { chipsFor, effectKey, opTitle, type CallerIndex } from '../graph/model.ts';
import { ActionsContext, EffectChip, EFFECT_META } from './Nodes.tsx';

function Examples({ op, scenario }: { op: Operation; scenario?: string }) {
  if (!op.examples?.length) return null;
  return (
    <section>
      <h4>Example calls <span className="muted small">(recorded running {scenario ?? 'the scenario'})</span></h4>
      {op.examples.map((e, i) => (
        <div key={i} className="example-block">
          <div className="example-head"><span>call {i + 1}: input</span></div>
          <pre className="example-json">{JSON.stringify(e.input, null, 2)}</pre>
          <div className="example-head"><span>{e.error ? 'throws' : 'output'}</span></div>
          <pre className="example-json">{e.error ?? JSON.stringify(e.output, null, 2)}</pre>
        </div>
      ))}
    </section>
  );
}

export type Selection =
  | { type: 'op'; id: string }
  | { type: 'entry'; id: string }
  | { type: 'resource'; id: string }
  | undefined;

export function Inspector({ g, index, selection, onSelect }: { g: ModuleGraph; index: CallerIndex; selection: Selection; onSelect: (s: Selection) => void }) {
  if (!selection) return <aside className="inspector empty">Click a module, entry point or data store to see its contract.</aside>;
  if (selection.type === 'op' && g.operations[selection.id]) return <OpInspector g={g} index={index} op={g.operations[selection.id]} onSelect={onSelect} />;
  if (selection.type === 'entry' && g.entryPoints[selection.id]) return <EntryInspector g={g} id={selection.id} />;
  if (selection.type === 'resource') return <ResourceInspector g={g} id={selection.id} onSelect={onSelect} />;
  return <aside className="inspector empty">Nothing selected.</aside>;
}

function findingsFor(g: ModuleGraph, ids: string[]): Finding[] {
  return g.findings.filter((f) => (f.subject && ids.includes(f.subject.id)) || f.related?.some((r) => ids.includes(r.id)));
}

function FindingList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  return (
    <section>
      <h4>Guardrails</h4>
      {findings.map((f, i) => (
        <div key={i} className={`finding sev-${f.severity}`}>
          <div><b>{f.severity === 'error' ? '✖' : f.severity === 'warning' ? '⚠' : 'ℹ'} {f.rule}</b>{f.isNew && <span className="badge b-added">new</span>}</div>
          <div>{f.message}</div>
          {f.hint && <div className="hint">{f.hint}</div>}
        </div>
      ))}
    </section>
  );
}

/** R12: questions only a human can answer, generated from the contract delta. */
function reviewPrompts(g: ModuleGraph, op: Operation): string[] {
  const mod = g.modules[op.moduleId];
  const prompts: string[] = [];
  const direct = new Set(op.directEffects.map(effectKey));
  for (const e of op.delta?.effectsAdded ?? []) {
    if (direct.has(effectKey(e)) && e.kind !== 'db.read') prompts.push(`Is ${mod.name} the right owner for ${e.kind} \`${e.target}\`? It now runs on every flow that reaches ${mod.name}.`);
    else if (direct.has(effectKey(e))) prompts.push(`${mod.name} now reads \`${e.target}\`. Is that table part of its data, or should another module own it?`);
  }
  if (op.delta?.params) prompts.push('The signature changed. Do all callers pass the right data, or should the old shape stay supported?');
  if (op.delta?.returns) prompts.push('The output shape changed. Do consumers rely on the old shape, and is the new field part of the public contract?');
  if (op.delta?.callsAdded.length) prompts.push(`New dependency on ${op.delta.callsAdded.map((c) => opTitle(g, c)).join(', ')}. Does that direction respect module layering?`);
  if (op.change === 'added') prompts.push('New operation: could an existing module already do this?');
  return prompts;
}

function OpInspector({ g, index, op, onSelect }: { g: ModuleGraph; index: CallerIndex; op: Operation; onSelect: (s: Selection) => void }) {
  const actions = useContext(ActionsContext);
  const mod = g.modules[op.moduleId];
  const [showCode, setShowCode] = useState(op.change !== 'unchanged');
  const chips = chipsFor(op);
  const declared = new Set(mod.declaredEffects.map(effectKey));
  const reach = index.reach.get(op.id)?.size ?? 0;
  const callers = [...(index.callers.get(op.id) ?? [])];
  const before = op.delta?.returns?.before.fields ?? [];
  const prompts = reviewPrompts(g, op);
  return (
    <aside className="inspector" key={op.id}>
      <div className="insp-head">
        <div className="insp-title">{mod.name}<span className="muted">.{op.name}()</span></div>
        <div className="insp-sub">
          {op.change !== 'unchanged' && <span className={`badge b-${op.change}`}>{op.change}</span>}
          {op.delta && <span className={`badge risk-${op.delta.risk}`}>{op.delta.risk} risk</span>}
          {mod.owner && <span className="owner">owner: {mod.owner}</span>}
        </div>
        <p className="summary">{mod.summary}</p>
        <div className="file">{op.file}:{op.line}</div>
        <div className="insp-actions">
          <button onClick={() => actions.drill(op.id)}>Drill in ⤵</button>
          <button onClick={() => actions.zoomOut(op.id)}>Zoom out ⤴: {reach} entry point{reach === 1 ? '' : 's'}</button>
        </div>
      </div>

      {prompts.length > 0 && (
        <section className="prompts">
          <h4>Review questions</h4>
          <ul>{prompts.map((p) => <li key={p}>{p}</li>)}</ul>
        </section>
      )}

      <section>
        <h4>Inputs</h4>
        {op.delta?.params && <div className="delta-line removed">− ({op.delta.params.before.map((p) => `${p.name}: ${p.type}`).join(', ')})</div>}
        {op.params.length ? op.params.map((p) => <div className="param" key={p.name}>{p.name}: <span>{p.type}</span></div>) : <div className="muted">none</div>}
      </section>

      <section>
        <h4>Output</h4>
        <div className="param"><span>{op.returns.type}</span></div>
        {(op.returns.fields ?? []).map((f) => (
          <div key={f.name} className={`param indent ${op.delta?.returns && !before.some((b) => b.name === f.name) ? 'added' : ''}`}>{f.name}: <span>{f.type}</span></div>
        ))}
        {before.filter((b) => !(op.returns.fields ?? []).some((f) => f.name === b.name)).map((f) => (
          <div key={f.name} className="param indent removed">{f.name}: <span>{f.type}</span></div>
        ))}
      </section>

      <Examples op={op} scenario={g.source.examples?.scenario} />

      <section>
        <h4>Side effects</h4>
        {chips.length === 0 && <div className="muted">None: pure logic.</div>}
        {chips.map((c) => (
          <div key={`${c.kind}${c.target}${c.delta}`} className="effect-row">
            <EffectChip chip={c} />
            <span className="muted small">
              {c.direct ? (declared.has(`${c.kind} ${c.target}`) ? 'declared ✓' : <b className="err">undeclared ✖</b>) : 'via submodule'}
            </span>
          </div>
        ))}
      </section>

      <section>
        <h4>Calls</h4>
        {op.calls.length === 0 && <div className="muted">no other modules</div>}
        {op.calls.map((c) => (
          <div key={c} className="linkrow" onClick={() => onSelect({ type: 'op', id: c })}>
            {op.delta?.callsAdded.includes(c) && <b className="add">+ </b>}{opTitle(g, c)}
          </div>
        ))}
        {op.delta?.callsRemoved.map((c) => <div key={c} className="linkrow removed">− {opTitle(g, c)}</div>)}
      </section>

      <section>
        <h4>Called by ({callers.length})</h4>
        {callers.slice(0, 12).map((c) => (
          <div key={c} className="linkrow" onClick={() => onSelect(g.entryPoints[c] ? { type: 'entry', id: c } : { type: 'op', id: c })}>
            {g.entryPoints[c] ? g.entryPoints[c].label : opTitle(g, c)}
          </div>
        ))}
        {callers.length > 12 && <div className="muted">…and {callers.length - 12} more. Use zoom out.</div>}
      </section>

      <FindingList findings={findingsFor(g, [op.id, op.moduleId])} />

      <section>
        <h4 className="clickable" onClick={() => setShowCode(!showCode)}>{showCode ? '▾' : '▸'} {op.diff ? 'Code diff' : 'Code'} <span className="muted small">(drill to lines only when you need to)</span></h4>
        {showCode && (
          <pre className="code-block">
            {(op.diff ?? op.source.split('\n').map((text) => ({ t: ' ' as const, text }))).map((l, i) => (
              <div key={i} className={`dl dl-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>{l.t} {l.text}</div>
            ))}
          </pre>
        )}
      </section>
    </aside>
  );
}

function EntryInspector({ g, id }: { g: ModuleGraph; id: string }) {
  const actions = useContext(ActionsContext);
  const entry = g.entryPoints[id];
  const added = new Set((entry.effectsAdded ?? []).map(effectKey));
  const effects: (Effect & { delta?: '+' | '-' })[] = [
    ...entry.effects.map((e) => ({ ...e, delta: added.has(effectKey(e)) ? ('+' as const) : undefined })),
    ...(entry.effectsRemoved ?? []).map((e) => ({ ...e, delta: '-' as const })),
  ];
  return (
    <aside className="inspector" key={id}>
      <div className="insp-head">
        <div className="insp-title">{entry.label}</div>
        <div className="insp-sub">
          <span className="badge">{entry.kind}</span>
          {entry.readOnly && <span className="badge">read-only</span>}
          {entry.change !== 'unchanged' && <span className={`badge b-${entry.change}`}>{entry.change}</span>}
          {entry.containsChanges && entry.change === 'unchanged' && <span className="badge b-inside">changes inside</span>}
        </div>
        <div className="file">{entry.file}:{entry.line}</div>
        <div className="insp-actions"><button onClick={() => actions.openEntry(id)}>Open flow ▸</button></div>
      </div>
      <section>
        <h4>Everything this flow touches ({entry.effects.length})</h4>
        {effects.map((e) => (
          <div key={`${effectKey(e)}${e.delta}`} className="effect-row">
            <EffectChip chip={{ kind: e.kind, target: e.target, direct: true, delta: e.delta }} />
          </div>
        ))}
      </section>
      <FindingList findings={findingsFor(g, [id])} />
    </aside>
  );
}

function ResourceInspector({ g, id, onSelect }: { g: ModuleGraph; id: string; onSelect: (s: Selection) => void }) {
  const [, kind, ...rest] = id.split(':');
  const target = rest.join(':');
  const touching = Object.values(g.operations).filter((op) => op.change !== 'removed' && op.directEffects.some((e) => e.target === target));
  return (
    <aside className="inspector">
      <div className="insp-head">
        <div className="insp-title">{target}</div>
        <div className="insp-sub"><span className="badge">{kind}</span></div>
      </div>
      <section>
        <h4>Touched directly by</h4>
        {touching.map((op) => (
          <div key={op.id} className="linkrow" onClick={() => onSelect({ type: 'op', id: op.id })}>
            {op.directEffects.filter((e) => e.target === target).map((e) => <span key={e.kind} className={`chip ${EFFECT_META[e.kind].cls} direct`}>{EFFECT_META[e.kind].label}</span>)}{' '}
            {opTitle(g, op.id)}
          </div>
        ))}
      </section>
    </aside>
  );
}
