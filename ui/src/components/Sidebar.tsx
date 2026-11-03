import { useContext, useMemo, useState } from 'react';
import type { Finding, ModuleGraph } from '../../../schema/modulegraph.ts';
import { opTitle } from '../graph/model.ts';
import { ActionsContext } from './Nodes.tsx';

/** Slim review rail: find anything, start at the riskiest change, see what the machine already checked. */
export function Sidebar({ g }: { g: ModuleGraph }) {
  const actions = useContext(ActionsContext);
  const [query, setQuery] = useState('');
  const [showOld, setShowOld] = useState(false);
  const hasDiff = g.source.mode !== 'snapshot';

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const entries = Object.values(g.entryPoints)
      .filter((e) => e.change !== 'removed' && e.label.toLowerCase().includes(q))
      .map((e) => ({ id: e.id, label: e.label, kind: e.kind as string, open: () => actions.openEntry(e.id) }));
    const ops = Object.values(g.operations)
      .filter((op) => op.change !== 'removed' && opTitle(g, op.id).toLowerCase().includes(q))
      .map((op) => ({ id: op.id, label: opTitle(g, op.id), kind: 'module', open: () => actions.zoomOut(op.id) }));
    return [...entries, ...ops].slice(0, 12);
  }, [g, query, actions]);

  const severity = { error: 0, warning: 1, info: 2 };
  const sorted = [...g.findings].sort((a, b) => severity[a.severity] - severity[b.severity]);
  const current = sorted.filter((f) => f.isNew || !hasDiff);
  const old = hasDiff ? sorted.filter((f) => !f.isNew) : [];
  const counts = (list: Finding[]) =>
    (['error', 'warning'] as const).map((s) => [s, list.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);

  const focus = (f: Finding) => {
    const s = f.subject;
    if (!s) return;
    if (s.type === 'entry') actions.openEntry(s.id);
    else if (s.type === 'operation') actions.zoomOut(s.id);
    else if (s.type === 'module') {
      const ops = g.modules[s.id]?.operations ?? [];
      const op = ops.find((o) => g.operations[o]?.change !== 'unchanged') ?? ops[0];
      if (op) actions.zoomOut(op);
    }
  };

  return (
    <nav className="sidebar">
      <div className="search">
        <input placeholder="Find an entry point or module…" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) { results[0].open(); setQuery(''); } if (e.key === 'Escape') setQuery(''); }} />
        {results.length > 0 && (
          <div className="search-results">
            {results.map((r) => (
              <div key={r.id} className="search-item" onClick={() => { r.open(); setQuery(''); }}>
                <span className={`kind-dot k-${r.kind}`} />{r.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {hasDiff && (
        <section>
          <h3>
            Start here
            {g.review.reviewers.length > 0 && <span className="muted small"> · owners {g.review.reviewers.join(', ')}</span>}
          </h3>
          {g.review.queue.map((q) => (
            <div key={q.operation} className="queue-item" onClick={() => actions.zoomOut(q.operation)} title={q.reason}>
              <span className={`badge risk-${q.risk}`}>{q.risk}</span>
              <span className="queue-name">{opTitle(g, q.operation)}</span>
              <span className="muted small reach" title="entry points that reach it">⤴ {q.reach}</span>
              <div className="queue-reason">{q.reason}</div>
            </div>
          ))}
          {g.review.queue.length === 0 && <div className="muted small">No module changes.</div>}
        </section>
      )}

      <section>
        <h3>
          Checks
          <span className="muted small"> · {counts(current).map(([s, n]) => `${n} ${s}${n > 1 ? 's' : ''}`).join(', ') || 'all clear'}{hasDiff ? ' (new)' : ''}</span>
        </h3>
        {current.map((f, i) => <CheckRow key={i} f={f} onClick={() => focus(f)} />)}
        {old.length > 0 && (
          <div className="small clickable muted" onClick={() => setShowOld(!showOld)}>
            {showOld ? '▾' : '▸'} {old.length} pre-existing, not caused by this change
          </div>
        )}
        {showOld && old.map((f, i) => <CheckRow key={`o${i}`} f={f} onClick={() => focus(f)} />)}
      </section>
    </nav>
  );
}

function CheckRow({ f, onClick }: { f: Finding; onClick: () => void }) {
  const icon = f.severity === 'error' ? '✖' : f.severity === 'warning' ? '⚠' : 'ℹ';
  return (
    <div className={`check sev-${f.severity}`} onClick={onClick} title={[f.message, f.hint].filter(Boolean).join('\n\n')}>
      <span className="check-icon">{icon}</span>
      <span className="check-text">{f.message}</span>
    </div>
  );
}
