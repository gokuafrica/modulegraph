import { useContext, useState } from 'react';
import type { Effect, Finding, ModuleGraph, Operation } from '../../../schema/modulegraph.ts';
import { chipsFor, effectKey, opTitle } from '../graph/model.ts';
import { ActionsContext, EffectChip, EFFECT_META } from './Nodes.tsx';
import { exampleLabels, ObjectTree } from './ObjectTree.tsx';

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
  const [showCode, setShowCode] = useState(false);
  const actions = useContext(ActionsContext);
  const chips = chipsFor(op);
  const declared = new Set(mod.declaredEffects.map(effectKey));
  const before = op.delta?.returns?.before.fields ?? [];
  const labels = exampleLabels((op.examples ?? []).map((e) => e.input));
  const addedFields = new Set(op.delta?.returns ? (op.returns.fields ?? []).filter((f) => !before.some((b) => b.name === f.name)).map((f) => f.name) : []);
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
        <div className="file" title="The diagram shows this revision of the code">{op.file}:{op.line} <span className="muted">· {revisionNote(g)}</span></div>
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
          <h4>Example calls <span className="muted small">recorded by running {g.source.examples?.scenario ?? 'a scenario'} on the head revision</span></h4>
          {op.examples.map((e, i) => (
            <div key={i} className="example-block blackbox">
              <div className="bb-head">call {i + 1}{labels[i] && <span className="muted"> · {labels[i]}</span>}</div>
              <div className="bb-side"><span className="bb-tag">in</span><ObjectTree value={e.input} flat /></div>
              <div className="bb-side"><span className={`bb-tag ${e.error ? 'err' : ''}`}>{e.error ? 'throws' : 'out'}</span>
                {e.error ? <span className="err">{e.error}</span> : <ObjectTree value={e.output} flat added={addedFields} />}
              </div>
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

      {op.changes?.length ? (
        <section>
          <h4>Code changes <span className="muted small">{op.changes.length} function{op.changes.length > 1 ? 's' : ''} · <span className="plus">+{op.changes.reduce((n, c) => n + c.added, 0)}</span> <span className="minus">−{op.changes.reduce((n, c) => n + c.removed, 0)}</span></span></h4>
          {op.changes.map((c) => (
            <button key={c.name} className="linkrow fn-row" onClick={() => actions.showDiff(op.id)} title={`${c.file}:${c.line}`}>
              <span className={`st st-${c.status}`}>{c.status[0].toUpperCase()}</span> <b>{c.name}</b>
              <span className="muted small"> {c.file.split('/').pop()}</span>
              <span className="counts small"><span className="plus">+{c.added}</span> <span className="minus">−{c.removed}</span></span>
            </button>
          ))}
          <div className="insp-actions"><button onClick={() => actions.showDiff(op.id)}>Open diff ▸</button></div>
        </section>
      ) : null}

      <section>
        <h4 className="clickable" onClick={() => setShowCode(!showCode)}>{showCode ? '▾' : '▸'} Code <span className="muted small">{g.source.head ? `as of ${g.source.head}` : ''}</span></h4>
        {showCode && (
          <pre className="code-block">
            {op.source.split('\n').map((l, i) => <div key={i} className="dl dl-ctx">{l}</div>)}
          </pre>
        )}
      </section>
    </div>
  );
}

/** Which checkout the shown code is from: reviewers comparing against files need the head, not main. */
function revisionNote(g: ModuleGraph): string {
  const s = g.source;
  if (s.mode === 'snapshot') return 'current tree';
  if (s.mode === 'uncommitted') return 'working tree';
  return `on ${s.head} (not ${s.base})`;
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
