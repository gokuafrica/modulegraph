import { useContext, useMemo, useState } from 'react';
import type { EntryKind, Finding, ModuleGraph } from '../../../schema/modulegraph.ts';
import { opTitle, type CallerIndex } from '../graph/model.ts';
import { ActionsContext } from './Nodes.tsx';
import type { Selection } from './Inspector.tsx';

const KIND_LABEL: Record<EntryKind, string> = { api: 'REST', grpc: 'gRPC', consumer: 'Kafka consumers', cron: 'Cron jobs' };

export function Sidebar({ g, index, onSelect }: { g: ModuleGraph; index: CallerIndex; onSelect: (s: Selection) => void }) {
  const actions = useContext(ActionsContext);
  const [affectedOnly, setAffectedOnly] = useState(g.source.mode !== 'snapshot');
  const [query, setQuery] = useState('');
  const [showOld, setShowOld] = useState(false);
  const r = g.review;
  const hasDiff = g.source.mode !== 'snapshot';

  const entries = useMemo(() => {
    const list = Object.values(g.entryPoints)
      .filter((e) => !affectedOnly || e.containsChanges)
      .filter((e) => !query || e.label.toLowerCase().includes(query.toLowerCase()));
    const byKind = new Map<EntryKind, typeof list>();
    for (const e of list) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
    return byKind;
  }, [g, affectedOnly, query]);

  const newFindings = g.findings.filter((f) => f.isNew || !hasDiff);
  const oldFindings = hasDiff ? g.findings.filter((f) => !f.isNew) : [];
  const focusFinding = (f: Finding) => {
    if (!f.subject) return;
    if (f.subject.type === 'entry') actions.openEntry(f.subject.id);
    else if (f.subject.type === 'module') {
      const op = g.modules[f.subject.id]?.operations.find((o) => g.operations[o].change !== 'unchanged') ?? g.modules[f.subject.id]?.operations[0];
      if (op) actions.zoomOut(op);
    } else if (f.subject.type === 'operation') actions.zoomOut(f.subject.id);
  };

  return (
    <nav className="sidebar">
      {hasDiff && (
        <section className="card">
          <div className="card-title">{g.source.title ?? 'Change'}</div>
          <div className="muted small">{g.source.mode}: {g.source.base} → {g.source.head}</div>
          <div className="stats">
            <span><b>{r.stats.contractChanges}</b> contract changes</span>
            <span><b>{r.stats.entryPointsAffected}</b> entry points affected</span>
            <span><b>{r.stats.files}</b> files <span className="add">+{r.stats.linesAdded}</span> <span className="del">−{r.stats.linesRemoved}</span></span>
          </div>
          {r.reviewers.length > 0 && <div className="small">Request review: {r.reviewers.map((o) => <span key={o} className="owner">{o}</span>)}</div>}
        </section>
      )}

      {hasDiff && (
        <section>
          <h3>Review queue <span className="muted small">riskiest first</span></h3>
          {r.queue.map((q) => (
            <div key={q.operation} className="queue-item" onClick={() => { onSelect({ type: 'op', id: q.operation }); actions.zoomOut(q.operation); }}>
              <div className="queue-top">
                <span className={`badge risk-${q.risk}`}>{q.risk}</span>
                <b>{opTitle(g, q.operation)}</b>
                <span className="muted small reach" title="entry points reaching this">⤴ {q.reach}</span>
              </div>
              <div className="small muted">{q.reason}</div>
            </div>
          ))}
          {r.queue.length === 0 && <div className="muted small">No module changes.</div>}
        </section>
      )}

      <section>
        <h3>Guardrails <span className="muted small">{newFindings.length} {hasDiff ? 'new' : ''}</span></h3>
        {newFindings.map((f, i) => <FindingRow key={i} f={f} onClick={() => focusFinding(f)} />)}
        {oldFindings.length > 0 && (
          <div className="small clickable muted" onClick={() => setShowOld(!showOld)}>
            {showOld ? '▾' : '▸'} {oldFindings.length} pre-existing (not caused by this change)
          </div>
        )}
        {showOld && oldFindings.map((f, i) => <FindingRow key={`o${i}`} f={f} onClick={() => focusFinding(f)} />)}
      </section>

      <section>
        <h3>Entry points <span className="muted small">{Object.keys(g.entryPoints).length}</span></h3>
        <div className="filters">
          <input placeholder="filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {hasDiff && (
            <label className="small"><input type="checkbox" checked={affectedOnly} onChange={(e) => setAffectedOnly(e.target.checked)} /> affected only</label>
          )}
        </div>
        {[...entries.entries()].map(([kind, list]) => (
          <div key={kind}>
            <div className="kind-title">{KIND_LABEL[kind]}</div>
            {list.map((e) => (
              <div key={e.id} className={`entry-item ${e.containsChanges ? 'affected' : ''}`} onClick={() => actions.openEntry(e.id)}>
                <span className="entry-item-label">{e.label.replace(/^(topic|cron|gRPC) /, '')}</span>
                {e.change !== 'unchanged' && <span className={`badge b-${e.change}`}>{e.change}</span>}
                {e.effectsAdded?.some((x) => x.kind !== 'db.read' && x.kind !== 'http') && e.readOnly && <span className="warn-text" title="read-only entry point now writes">⚠</span>}
              </div>
            ))}
          </div>
        ))}
      </section>
      <section className="muted small">
        {Object.keys(g.modules).length} modules · {Object.keys(g.operations).length} operations · index of {index.callers.size} callees
      </section>
    </nav>
  );
}

function FindingRow({ f, onClick }: { f: Finding; onClick: () => void }) {
  return (
    <div className={`finding sev-${f.severity} clickable`} onClick={onClick} title={f.hint}>
      <b>{f.severity === 'error' ? '✖' : f.severity === 'warning' ? '⚠' : 'ℹ'} {f.rule}</b>
      <div>{f.message}</div>
    </div>
  );
}
