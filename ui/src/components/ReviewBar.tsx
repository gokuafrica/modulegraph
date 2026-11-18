import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisIssue, Finding, ModuleGraph, ReviewChange } from '../../../schema/modulegraph.ts';
import { opTitle } from '../graph/model.ts';
import { ActionsContext } from './Nodes.tsx';

/**
 * The review's home base, always on screen: one chip per change (riskiest first), named after the module where it
 * begins; changed modules reached only through it are counted inside it, not listed again. A chip opens that
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
        {g.review.changes.map((c) => (
          <button key={c.root} className={`change-chip ${home === c.root ? 'on' : ''}`} onClick={() => onHome(c.root)} title={changeTip(g, c)}>
            <span className={`badge risk-${c.risk}`}>{c.risk}</span>
            <span className="change-name">{opTitle(g, c.root)}</span>
            {c.parts.length > 0 && <span className="change-parts">+{c.parts.length} inside</span>}
            <span className={`st-dot st-${g.operations[c.root]?.change ?? 'modified'}`} />
          </button>
        ))}
        {hasDiff && g.review.changes.length === 0 && <span className="muted small">no module changes</span>}
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

/** What a change chip says on hover: why the root changed, the changed modules inside it, and how far it reaches. */
function changeTip(g: ModuleGraph, c: ReviewChange): string {
  const why = new Map(g.review.queue.map((q) => [q.operation, q]));
  return [
    `${opTitle(g, c.root)}: ${c.risk} change risk (${why.get(c.root)?.reason})`,
    ...(c.parts.length ? ['', 'Changed inside it (reached only through it):', ...c.parts.map((p) => `  ${why.get(p)?.risk}  ${opTitle(g, p)}: ${why.get(p)?.reason}`)] : []),
    ...(c.alsoIn?.length ? ['', `Also reached through the change in ${c.alsoIn.map((r) => opTitle(g, r)).join(', ')}; other flows reach it too.`] : []),
    '',
    `Reached from ${c.reach} entry point${c.reach === 1 ? '' : 's'}. Click: everything that calls it.`,
  ].join('\n');
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
  // The brief's verdict: an analysis that could not see everything is not "all clear", whatever the rules found.
  const all = g.incomplete ?? [];
  // A property that fails on one operation is shown on its box, not as a review-wide state.
  const incomplete = all.filter((i) => !(i.kind === 'invariant' && i.scope && g.operations[i.scope]));
  const scoped = all.filter((i) => !incomplete.includes(i));
  const state = errors ? 'sev-error' : incomplete.length ? 'sev-incomplete' : warnings ? 'sev-warning' : 'ok';
  const label = incomplete.length
    ? `◐ incomplete analysis${summary ? `, ${summary}` : ''}`
    : `${errors ? '✖' : warnings ? '⚠' : '✓'} checks${summary ? `: ${summary}` : current.length ? `: ${current.length} note${current.length > 1 ? 's' : ''}` : ': all clear'}`;
  return (
    <div className="checks-menu" ref={ref}>
      <button className={`checks-button ${state}`} onClick={() => setOpen(!open)}
        title={incomplete.length
          ? `The analysis could not see everything (${incomplete.map((i) => i.kind).join(', ')}): "no findings" means nothing here. Click for what is missing and the profile rules that fix it.`
          : 'What the machine checked: architecture rules, undeclared and undisclosed side effects'}>
        {label}
      </button>
      {open && (
        <div className="checks-pop">
          {incomplete.length > 0 && (
            <div className="incomplete-block">
              <div className="incomplete-title">Analysis incomplete: what follows may be missing side effects, entry points or changes</div>
              {incomplete.map((issue, i) => <IncompleteRow key={i} issue={issue} profile={g.source.profile?.path} />)}
            </div>
          )}
          {scoped.length > 0 && (
            <div className="small muted">On single operations (⚠ on their boxes): {scoped.map((i) => i.message).join('; ')}</div>
          )}
          {current.length === 0 && <div className="muted small">{incomplete.length ? 'No findings from the parts the analysis sees.' : `Nothing new${hasDiff ? ' from this change' : ''}.`}</div>}
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

/** One thing the analysis could not see, what to do about it, and the profile JSON that fixes it (copyable). */
function IncompleteRow({ issue, profile }: { issue: AnalysisIssue; profile?: string }) {
  // Few items: shown at once, next to the rule that acts on them. Many: behind one more click.
  const [details, setDetails] = useState((issue.items?.length ?? 0) <= 8);
  const [copied, setCopied] = useState(false);
  return (
    <div className="incomplete-issue" data-kind={issue.kind}>
      <div className="incomplete-head"><code>{issue.kind}</code> {issue.message}</div>
      {issue.hint && <div className="small muted">{issue.hint}</div>}
      {(issue.items?.length ?? 0) > 0 && (
        <div className="small clickable muted" onClick={() => setDetails(!details)}>{details ? '▾' : '▸'} {issue.items!.length} sign{issue.items!.length > 1 ? 's' : ''}</div>
      )}
      {details && <ul className="incomplete-items">{issue.items!.map((it, i) => <li key={i}>{it}</li>)}</ul>}
      {issue.suggestion && (
        <div className="incomplete-suggestion">
          <div className="small muted">Add to the profile{profile ? <>, <code>{profile}</code></> : ''}:</div>
          <pre>{issue.suggestion}</pre>
          <button className="small" onClick={() => { void navigator.clipboard?.writeText(issue.suggestion!); setCopied(true); }}>{copied ? 'copied' : 'copy'}</button>
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
