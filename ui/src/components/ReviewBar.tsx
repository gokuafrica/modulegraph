import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Finding, ModuleGraph } from '../../../schema/modulegraph.ts';
import { opTitle } from '../graph/model.ts';
import { ActionsContext } from './Nodes.tsx';

/**
 * The review's home base, always on screen: one chip per changed module (riskiest first). A chip opens that
 * module's impact view and starts a new path from it, so wherever exploring leads, the change is one click away.
 * Also: find any entry point or module, and the machine checks.
 */
export function ReviewBar({ g, home, onHome }: { g: ModuleGraph; home?: string; onHome: (opId: string) => void }) {
  const actions = useContext(ActionsContext);
  const hasDiff = g.source.mode !== 'snapshot';
  return (
    <div className="review-bar">
      <span className="bar-label" title="What this change touches, riskiest first. Click one to see everything that calls it; your path starts again from there.">
        {hasDiff ? 'Changes' : 'No change (snapshot)'}
      </span>
      <div className="change-chips">
        {g.review.queue.map((q) => (
          <button key={q.operation} className={`change-chip ${home === q.operation ? 'on' : ''}`} onClick={() => onHome(q.operation)}
            title={`${q.reason}\nReached from ${q.reach} entry point${q.reach === 1 ? '' : 's'}. Click: everything that calls it.`}>
            <span className={`badge risk-${q.risk}`}>{q.risk}</span>
            <span className="change-name">{opTitle(g, q.operation)}</span>
            <span className={`st-dot st-${g.operations[q.operation]?.change ?? 'modified'}`} />
          </button>
        ))}
        {hasDiff && g.review.queue.length === 0 && <span className="muted small">no module changes</span>}
      </div>
      <div className="spacer" />
      <Search g={g} />
      <Checks g={g} focus={(f) => {
        const s = f.subject;
        if (!s) return;
        if (s.type === 'entry') actions.openEntry(s.id);
        else if (s.type === 'operation') actions.zoomOut(s.id);
        else if (s.type === 'module') actions.references(`module:${s.id}`);
      }} />
    </div>
  );
}

function Search({ g }: { g: ModuleGraph }) {
  const actions = useContext(ActionsContext);
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const entries = Object.values(g.entryPoints)
      .filter((e) => e.change !== 'removed' && e.label.toLowerCase().includes(q))
      .map((e) => ({ id: e.id, label: e.label, kind: e.kind as string, hint: 'flow', open: () => actions.openEntry(e.id) }));
    const ops = Object.values(g.operations)
      .filter((op) => op.change !== 'removed' && opTitle(g, op.id).toLowerCase().includes(q))
      .map((op) => ({ id: op.id, label: opTitle(g, op.id), kind: 'module', hint: 'references', open: () => actions.references(op.id) }));
    // A whole module: references to any of its operations.
    const mods = Object.values(g.modules)
      .filter((m) => m.change !== 'removed' && m.name.toLowerCase().includes(q) && m.operations.length > 1)
      .map((m) => ({ id: `module:${m.id}`, label: `${m.name} (all ${m.operations.length} operations)`, kind: 'module', hint: 'references', open: () => actions.references(`module:${m.id}`) }));
    return [...entries, ...mods, ...ops].slice(0, 14);
  }, [g, query, actions]);
  return (
    <div className="search">
      <input placeholder="Find an entry point or module…" value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) { results[0].open(); setQuery(''); } if (e.key === 'Escape') setQuery(''); }} />
      {results.length > 0 && (
        <div className="search-results">
          {results.map((r) => (
            <div key={r.id} className="search-item" onClick={() => { r.open(); setQuery(''); }}>
              <span className={`kind-dot k-${r.kind}`} />{r.label}<span className="muted small search-hint">{r.hint}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Checks({ g, focus }: { g: ModuleGraph; focus: (f: Finding) => void }) {
  const [open, setOpen] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const hasDiff = g.source.mode !== 'snapshot';
  const severity = { error: 0, warning: 1, info: 2 };
  const sorted = [...g.findings].sort((a, b) => severity[a.severity] - severity[b.severity]);
  const current = sorted.filter((f) => f.isNew || !hasDiff);
  const old = hasDiff ? sorted.filter((f) => !f.isNew) : [];
  const errors = current.filter((f) => f.severity === 'error').length;
  const warnings = current.filter((f) => f.severity === 'warning').length;
  const summary = [errors && `${errors} error${errors > 1 ? 's' : ''}`, warnings && `${warnings} warning${warnings > 1 ? 's' : ''}`].filter(Boolean).join(', ');
  return (
    <div className="checks-menu" ref={ref}>
      <button className={`checks-button ${errors ? 'sev-error' : warnings ? 'sev-warning' : 'ok'}`} onClick={() => setOpen(!open)}
        title="What the machine checked: architecture rules, undeclared and undisclosed side effects">
        {errors ? '✖' : warnings ? '⚠' : '✓'} checks{summary ? `: ${summary}` : current.length ? `: ${current.length} note${current.length > 1 ? 's' : ''}` : ': all clear'}
      </button>
      {open && (
        <div className="checks-pop">
          {current.length === 0 && <div className="muted small">Nothing new{hasDiff ? ' from this change' : ''}.</div>}
          {current.map((f, i) => <CheckRow key={i} f={f} onClick={() => { focus(f); setOpen(false); }} />)}
          {old.length > 0 && (
            <div className="small clickable muted" onClick={() => setShowOld(!showOld)}>
              {showOld ? '▾' : '▸'} {old.length} pre-existing, not caused by this change
            </div>
          )}
          {showOld && old.map((f, i) => <CheckRow key={`o${i}`} f={f} onClick={() => { focus(f); setOpen(false); }} />)}
        </div>
      )}
    </div>
  );
}

function CheckRow({ f, onClick }: { f: Finding; onClick: () => void }) {
  const icon = f.severity === 'error' ? '✖' : f.severity === 'warning' ? '⚠' : 'ℹ';
  return (
    <div className={`check sev-${f.severity}`} onClick={onClick} title={[f.message, f.hint].filter(Boolean).join('\n\n')}>
      <span className="check-icon">{icon}</span>
      <span className="check-text wrap">{f.message}</span>
    </div>
  );
}
