import { useContext, useState } from 'react';
import type { Effect, Finding, ModuleGraph, Operation, Param } from '../../../schema/modulegraph.ts';
import { chipsFor, effectKey, opTitle } from '../graph/model.ts';
import { ActionsContext, casesOf, EffectChip, EFFECT_META, ExampleContext } from './Nodes.tsx';
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
  const { caseId, setCase, cases } = useContext(ExampleContext);
  const addedFields = new Set(op.delta?.returns ? (op.returns.fields ?? []).filter((f) => !before.some((b) => b.name === f.name)).map((f) => f.name) : []);
  return (
    <div key={op.id}>
      <div className="insp-head">
        <div className="insp-title">{mod.name}<span className="muted">.{op.name}()</span></div>
        <div className="insp-sub">
          {op.change !== 'unchanged' && <span className={`badge b-${op.change}`}>{op.change}</span>}
          <RiskBadges g={g} op={op} />
          {mod.owner && <span className="owner">{mod.owner}</span>}
        </div>
        {op.summary && <p className="summary">{op.summary} <SummarySource source={op.summary && op.summarySource} from={op.summaryFrom} /></p>}
        {mod.summary && mod.summary !== op.summary && <p className="summary module-summary"><b>{mod.name}:</b> {mod.summary} <SummarySource source={mod.summarySource} /></p>}
        {!op.summary && op.context && (
          <p className="summary context-summary">
            <span className="context-label">Called through {opTitle(g, op.context.from)}:</span> {op.context.summary}{' '}
            <span className="summary-src" title={`${op.context.from} only hands over to this operation; this is its description, not one of this operation's own.`}>context, not its own description</span>
          </p>
        )}
        {!op.summary && <MissingDescription g={g} op={op} />}
        <div className="file" title="The diagram shows this revision of the code">{op.file}:{op.line} <span className="muted">· {revisionNote(g)}</span></div>
        <div className="insp-actions">
          <button onClick={() => actions.references(op.id)} title="Impact view: everything that calls this operation, up to the entry points (Shift+F12)">Show references ⤴</button>
          {mod.operations.length > 1 && <button onClick={() => actions.references(`module:${mod.id}`)} title="Impact view: everything that calls any operation of this module">all of {mod.name} ⤴</button>}
        </div>
      </div>

      <section>
        <h4>Inputs</h4>
        {op.delta?.params && <div className="delta-line removed">− ({op.delta.params.before.map((p) => `${p.name}: ${p.type}`).join(', ')})</div>}
        {op.params.length ? op.params.map((p) => <ParamRow key={p.name} p={p} />) : <div className="muted">none</div>}
      </section>

      <section>
        <h4>Output</h4>
        <div className="param"><span>{op.returns.type}</span></div>
        {(op.returns.fields ?? []).map((f) => (
          <div key={f.name} className={`param indent ${op.delta?.returns && !before.some((b) => b.name === f.name) ? 'added' : ''}`} title={f.description}>
            {f.name}: <span>{f.type}</span>{f.description && <div className="param-doc">{f.description}</div>}
          </div>
        ))}
        {before.filter((b) => !(op.returns.fields ?? []).some((f) => f.name === b.name)).map((f) => (
          <div key={f.name} className="param indent removed">{f.name}: <span>{f.type}</span></div>
        ))}
      </section>

      {op.examples?.length ? (
        <section>
          {g.source.examples?.kind === 'tests' ? (
            <h4 title={`Recorded by running these specs on the head revision:\n${(g.source.examples.specs ?? []).join('\n')}\n\nThe values come from the tests' mocks and fixtures, not from real requests.`}>
              Example calls <span className="muted small"><span className="tests-tag">from unit tests (mocked dependencies)</span> {g.source.examples.specs?.length ?? 0} spec file{g.source.examples.specs?.length === 1 ? '' : 's'}; click one to follow its test everywhere</span>
            </h4>
          ) : (
            <h4>Example calls <span className="muted small">recorded by running {g.source.examples?.scenario ?? 'a scenario'} on the head revision; click one to follow its request everywhere</span></h4>
          )}
          {op.examples.map((e, i) => {
            const ids = casesOf(e, i);
            const names = ids.map((id) => cases[id]).filter(Boolean);
            const on = !!caseId && ids.includes(caseId);
            return (
            <div key={i} className={`example-block blackbox ${on ? 'on' : ''}`} onClick={() => setCase(on ? caseId! : ids[0])} title={names.join('\n')}>
              <div className="bb-head">
                call {i + 1}{labels[i] && <span className="muted"> · {labels[i]}</span>}
                {names.length > 0 && <div className="bb-requests">{on && caseId ? cases[caseId] : names[0]}{names.length > 1 ? <span className="muted"> and {names.length - 1} more request{names.length > 2 ? 's' : ''}</span> : null}</div>}
              </div>
              <div className="bb-side"><span className="bb-tag">in</span><ObjectTree value={e.input} flat /></div>
              <div className="bb-side"><span className={`bb-tag ${e.error ? 'rejected' : ''}`} title={e.error ? 'This request was answered with an error: what the code does on purpose when the check fails' : undefined}>{e.error ? (e.status ? `HTTP ${e.status}` : 'throws') : 'out'}</span>
                {e.error ? <span className="rejected">{e.status ? 'rejected: ' : ''}{e.error}</span> : <ObjectTree value={e.output} flat added={addedFields} />}
              </div>
            </div>
            );
          })}
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
            <button key={c.name} className="linkrow fn-row" onClick={() => actions.showDiff(op.id)} title={`${c.name}\n${c.file}:${c.line}`}>
              <span className={`st st-${c.status}`}>{c.status[0].toUpperCase()}</span>
              {/* A helper of the operation's own class needs no class name: the name stays short enough to read. */}
              <b className="fn-name">{c.name.startsWith(`${mod.className}.`) ? c.name.slice(mod.className.length + 1) : c.name}</b>
              <span className="muted small fn-file">{c.file.split('/').pop()}</span>
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

/**
 * One word for risk everywhere: the change's risk, the value the Changes bar and the brief show (it counts steps
 * added or removed inside, and the changes reached through it). The contract's own risk (inputs, outputs, side
 * effects only) is a detail next to it, named as such, so the two never read as a contradiction.
 */
function RiskBadges({ g, op }: { g: ModuleGraph; op: Operation }) {
  if (op.change === 'unchanged' && !op.containsChanges) return null;
  const q = g.review.queue.find((x) => x.operation === op.id);
  const asChange = g.review.changes.find((c) => c.root === op.id);
  const risk = asChange?.risk ?? q?.risk;
  const contract = op.delta && op.change !== 'unchanged' ? op.delta.risk : undefined;
  return (
    <>
      {risk && (
        <span className={`badge risk-${risk}`} title={`Change risk (the same as in the Changes bar and the brief): ${q?.reason ?? 'changes inside'}${asChange && q && asChange.risk !== q.risk ? `; ${q.risk} on its own, ${asChange.risk} with the changes inside it` : ''}.`}>
          change: {risk}
        </span>
      )}
      {contract && (
        <span className="badge contract-risk" title="Contract risk: what callers see (inputs, outputs, side effects). Behaviour inside the operation is not part of it.">
          contract: {contract}
        </span>
      )}
    </>
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
        {entry.summary && <p className="summary">{entry.summary} <SummarySource source={entry.summarySource} from={entry.summaryFrom} /></p>}
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

/** Where a description comes from: the code's doc comment, its API documentation, its class, or the review agent. */
function SummarySource({ source, from }: { source?: string; from?: string }) {
  if (source === 'profile') return <span className="summary-src agent" title="Not in the code: written in the service profile (configs/<service>/), usually by the review agent after reading the code">written by the review agent</span>;
  if (source === 'code') return <span className="summary-src" title="The code's own doc comment">from the code</span>;
  if (source === 'api') {
    // "@ApiOperation on PUT /api/…": the decorator on the tag, the endpoint in the tooltip.
    const decorator = from?.split(' on ')[0] ?? 'the API docs';
    return <span className="summary-src" title={`The service's API documentation${from ? `: ${from}` : ''}. The endpoint hands the request to this operation, so it describes it too.`}>from {decorator}</span>;
  }
  if (source === 'class') return <span className="summary-src" title="No doc comment on the method: this is the doc comment of its class">from the class's doc comment</span>;
  return null;
}

/** An input, with the documented fields of its type (a DTO's `@ApiProperty` descriptions). */
function ParamRow({ p }: { p: Param }) {
  return (
    <div className="param" title={p.description}>
      {p.name}: <span>{p.type}</span>
      {p.description && <div className="param-doc">{p.description}</div>}
      {p.fields?.map((f) => (
        <div key={f.name} className="param indent" title={f.description}>
          {f.name}: <span>{f.type}</span>{f.description && <div className="param-doc">{f.description}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Nothing describes this operation (no doc comment, no API docs of an endpoint that hands to it, no class comment,
 * nothing in the profile). Says exactly how to fill it in, for a person and for their agent.
 */
function MissingDescription({ g, op }: { g: ModuleGraph; op: Operation }) {
  const mod = g.modules[op.moduleId];
  const profile = g.source.profile?.path ?? `~/.modulegraph/configs/${g.service}/modulegraph.config.json`;
  const snippet = `"modules": { "overrides": { "${mod.className}": { "operations": { "${op.name}": "…" } } } }`;
  const changed = op.change !== 'unchanged';
  return (
    <div className="summary muted missing-doc">
      <p>No description: no doc comment, no API docs (<code>@ApiOperation</code>) on an endpoint that hands to it, nothing in the profile.{changed ? ' It changed, so the review needs one.' : ''}</p>
      <p>Ask your agent: <i>“Describe {mod.className}.{op.name} in the modulegraph profile”</i> (module-review skill), or add it yourself in <code>{profile}</code>{g.source.profile?.exists ? '' : ' (create it)'}:</p>
      <pre className="code-block small">{snippet}</pre>
      <p>then ↻ refresh.</p>
    </div>
  );
}
