import { useContext, useState } from 'react';
import type { Effect, Finding, ModuleGraph, Operation } from '../../../schema/modulegraph.ts';
import { chipsFor, effectKey, opTitle } from '../graph/model.ts';
import { ActionsContext, EffectChip, EFFECT_META } from './Nodes.tsx';

export type Selection =
  | { type: 'op'; id: string }
  | { type: 'entry'; id: string }
  | { type: 'resource'; id: string }
  | undefined;

/** Contract card for the clicked node: what goes in, what comes out, what it touches, and the code if you want it. */
export function Inspector({ g, selection, onClose }: { g: ModuleGraph; selection: NonNullable<Selection>; onClose: () => void }) {
  let body: React.ReactNode = null;
  if (selection.type === 'op' && g.operations[selection.id]) body = <OpCard g={g} op={g.operations[selection.id]} />;
  else if (selection.type === 'entry' && g.entryPoints[selection.id]) body = <EntryCard g={g} id={selection.id} />;
  else if (selection.type === 'resource') body = <ResourceCard g={g} id={selection.id} />;
  return (
    <aside className="inspector">
      <button className="link close" onClick={onClose} title="Close">✕</button>
      {body}
    </aside>
  );
}

function Checks({ g, ids }: { g: ModuleGraph; ids: string[] }) {
  const findings = g.findings.filter((f: Finding) => (f.subject && ids.includes(f.subject.id)) || f.related?.some((r) => ids.includes(r.id)));
  if (!findings.length) return null;
  return (
    <section>
      <h4>Checks</h4>
      {findings.map((f, i) => (
        <div key={i} className={`check sev-${f.severity}`} title={f.hint}>
          <span className="check-icon">{f.severity === 'error' ? '✖' : f.severity === 'warning' ? '⚠' : 'ℹ'}</span>
          <span className="check-text wrap">{f.message}</span>
        </div>
      ))}
    </section>
  );
}

function OpCard({ g, op }: { g: ModuleGraph; op: Operation }) {
  const mod = g.modules[op.moduleId];
  const [showCode, setShowCode] = useState(op.change !== 'unchanged');
  const chips = chipsFor(op);
  const declared = new Set(mod.declaredEffects.map(effectKey));
  const before = op.delta?.returns?.before.fields ?? [];
  return (
    <div key={op.id}>
      <div className="insp-head">
        <div className="insp-title">{mod.name}<span className="muted">.{op.name}()</span></div>
        <div className="insp-sub">
          {op.change !== 'unchanged' && <span className={`badge b-${op.change}`}>{op.change}</span>}
          {op.delta && op.change !== 'unchanged' && <span className={`badge risk-${op.delta.risk}`}>{op.delta.risk} risk</span>}
          {mod.owner && <span className="owner">{mod.owner}</span>}
        </div>
        {mod.summary && <p className="summary">{mod.summary}</p>}
        <div className="file">{op.file}:{op.line}</div>
      </div>

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

      {op.examples?.length ? (
        <section>
          <h4>Example calls <span className="muted small">recorded from {g.source.examples?.scenario ?? 'a scenario run'}</span></h4>
          {op.examples.map((e, i) => (
            <div key={i} className="example-block">
              <div className="example-head"><span>call {i + 1} · input</span></div>
              <pre className="example-json">{JSON.stringify(e.input, null, 2)}</pre>
              <div className="example-head"><span>{e.error ? 'throws' : 'output'}</span></div>
              <pre className="example-json">{e.error ?? JSON.stringify(e.output, null, 2)}</pre>
            </div>
          ))}
        </section>
      ) : null}

      <section>
        <h4>Side effects</h4>
        {chips.length === 0 && <div className="muted">None: pure logic.</div>}
        {chips.map((c) => (
          <div key={`${c.kind}${c.target}${c.delta}`} className="effect-row">
            <EffectChip chip={c} />
            <span className="muted small">
              {!c.direct ? 'via submodule' : mod.contractSource && !declared.has(`${c.kind} ${c.target}`) ? <b className="err">undeclared ✖</b> : 'this module'}
            </span>
          </div>
        ))}
      </section>

      <Checks g={g} ids={[op.id, op.moduleId]} />

      <section>
        <h4 className="clickable" onClick={() => setShowCode(!showCode)}>{showCode ? '▾' : '▸'} {op.diff ? 'Code diff' : 'Code'}</h4>
        {showCode && (
          <pre className="code-block">
            {(op.diff ?? op.source.split('\n').map((text) => ({ t: ' ' as const, text }))).map((l, i) => (
              <div key={i} className={`dl dl-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>{l.t} {l.text}</div>
            ))}
          </pre>
        )}
      </section>
    </div>
  );
}

function EntryCard({ g, id }: { g: ModuleGraph; id: string }) {
  const actions = useContext(ActionsContext);
  const entry = g.entryPoints[id];
  const added = new Set((entry.effectsAdded ?? []).map(effectKey));
  const effects: (Effect & { delta?: '+' | '-' })[] = [
    ...entry.effects.map((e) => ({ ...e, delta: added.has(effectKey(e)) ? ('+' as const) : undefined })),
    ...(entry.effectsRemoved ?? []).map((e) => ({ ...e, delta: '-' as const })),
  ];
  return (
    <div key={id}>
      <div className="insp-head">
        <div className="insp-title">{entry.label}</div>
        <div className="insp-sub">
          <span className="badge">{entry.kind}</span>
          {entry.readOnly && <span className="badge">read-only</span>}
          {entry.change !== 'unchanged' && <span className={`badge b-${entry.change}`}>{entry.change}</span>}
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
      <Checks g={g} ids={[id]} />
    </div>
  );
}

function ResourceCard({ g, id }: { g: ModuleGraph; id: string }) {
  const [, kind, ...rest] = id.split(':');
  const target = rest.join(':');
  const touching = Object.values(g.operations).filter((op) => op.change !== 'removed' && op.directEffects.some((e) => e.target === target));
  return (
    <div>
      <div className="insp-head">
        <div className="insp-title">{target}</div>
        <div className="insp-sub"><span className="badge">{kind}</span></div>
      </div>
      <section>
        <h4>Touched directly by</h4>
        {touching.map((op) => (
          <div key={op.id} className="linkrow">
            {op.directEffects.filter((e) => e.target === target).map((e) => <span key={e.kind} className={`chip ${EFFECT_META[e.kind].cls} direct`}>{EFFECT_META[e.kind].label}</span>)}{' '}
            {opTitle(g, op.id)}
          </div>
        ))}
      </section>
    </div>
  );
}
