import { diffWordsWithSpace } from 'diff';
import { useMemo, useState } from 'react';
import type { CodeChange, DiffLine } from '../../../schema/modulegraph.ts';

const CONTEXT = 3;
const LONG_ADDED = 40;

/**
 * Code changes behind one operation or entry point, function by function. Big changes stay readable because:
 * functions are listed (with file and size) before any code, the operation's own method comes first and helpers
 * after, unchanged lines are folded to 3 lines of context, long new functions are clipped, and edited lines show
 * the changed words.
 */
export function DiffPanel({ title, changes, onClose }: { title: string; changes: CodeChange[]; onClose: () => void }) {
  const files = [...new Set(changes.map((c) => c.file))];
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  const [active, setActive] = useState(0);
  const scrollTo = (i: number) => {
    setActive(i);
    document.getElementById(`fn-change-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="diff-drawer">
      <div className="diff-head">
        <b>Code changes · {title}</b>
        <span className="muted small">
          {changes.length} function{changes.length === 1 ? '' : 's'} in {files.length} file{files.length === 1 ? '' : 's'} · <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
        </span>
        <div className="spacer" />
        <button className="link" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <div className="diff-body">
        <nav className="diff-nav">
          {files.map((file) => (
            <div key={file} className="diff-nav-file">
              <div className="diff-nav-path" title={file}>{shortPath(file)}</div>
              {changes.map((c, i) => c.file !== file ? null : (
                <button key={i} className={`diff-nav-fn ${i === active ? 'on' : ''}`} onClick={() => scrollTo(i)}>
                  <span className={`st st-${c.status}`}>{c.status[0].toUpperCase()}</span>
                  <span className="fn-name">{c.name}</span>
                  <span className="muted small">{c.role === 'helper' ? 'helper' : ''}</span>
                  <span className="counts"><span className="plus">+{c.added}</span> <span className="minus">−{c.removed}</span></span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="diff-main">
          {changes.map((c, i) => <FunctionDiff key={i} id={`fn-change-${i}`} change={c} />)}
        </div>
      </div>
    </div>
  );
}

export function FunctionDiff({ change, id, compact }: { change: CodeChange; id?: string; compact?: boolean }) {
  return (
    <section id={id} className="fn-diff">
      <div className="fn-diff-head">
        <span className={`badge b-${change.status === 'removed' ? 'removed' : change.status}`}>{change.status}</span>
        <b>{change.name}</b>
        <span className="muted small">{change.role === 'helper' ? 'inlined helper' : change.role}</span>
        <span className="muted small file">{change.file}:{change.line}</span>
        <span className="counts small"><span className="plus">+{change.added}</span> <span className="minus">−{change.removed}</span></span>
      </div>
      <Hunks lines={change.diff} max={compact ? 14 : undefined} />
    </section>
  );
}

type Row = { kind: 'line'; line: DiffLine; words?: { text: string; hl: boolean }[] } | { kind: 'gap'; from: number; to: number };

function Hunks({ lines, max }: { lines: DiffLine[]; max?: number }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const words = useMemo(() => wordDiffs(lines), [lines]);
  const rows: Row[] = [];
  const changed = lines.map((l) => l.t !== ' ');
  const near = (i: number) => changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean);
  for (let i = 0; i < lines.length; ) {
    if (near(i) || open.has(i)) {
      rows.push({ kind: 'line', line: lines[i], words: words.get(i) });
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !near(j)) j++;
    if (j - i <= 1) rows.push({ kind: 'line', line: lines[i], words: words.get(i) });
    else rows.push({ kind: 'gap', from: i, to: j });
    i = j - i <= 1 ? i + 1 : j;
  }
  const allNew = lines.every((l) => l.t === '+') || lines.every((l) => l.t === '-');
  const limit = max ?? (allNew ? LONG_ADDED : Infinity);
  const shown = showAll ? rows : rows.slice(0, limit);
  return (
    <div className="hunks">
      {shown.map((r, k) =>
        r.kind === 'gap' ? (
          <button key={k} className="gap" onClick={() => setOpen(new Set([...open, ...range(r.from, r.to)]))}>
            ⋯ {r.to - r.from} unchanged lines
          </button>
        ) : (
          <div key={k} className={`hl dl-${r.line.t === '+' ? 'add' : r.line.t === '-' ? 'del' : 'ctx'}`}>
            <span className="ln">{r.line.a ?? ''}</span>
            <span className="ln">{r.line.b ?? ''}</span>
            <span className="sign">{r.line.t}</span>
            <span className="code">
              {r.words ? r.words.map((w, i) => <span key={i} className={w.hl ? 'w-hl' : ''}>{w.text}</span>) : r.line.text}
            </span>
          </div>
        ),
      )}
      {rows.length > shown.length && (
        <button className="gap" onClick={() => setShowAll(true)}>show {rows.length - shown.length} more lines</button>
      )}
    </div>
  );
}

/** Pairs each run of removed lines with the added lines after it and marks the words that differ. */
function wordDiffs(lines: DiffLine[]): Map<number, { text: string; hl: boolean }[]> {
  const out = new Map<number, { text: string; hl: boolean }[]>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].t !== '-') { i++; continue; }
    const delStart = i;
    while (i < lines.length && lines[i].t === '-') i++;
    const addStart = i;
    while (i < lines.length && lines[i].t === '+') i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const parts = diffWordsWithSpace(lines[delStart + k].text, lines[addStart + k].text);
      // Rewritten lines: highlighting nearly every word says nothing, so only mark real edits.
      const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.trim().length, 0);
      if (same < 0.4 * Math.max(lines[delStart + k].text.trim().length, lines[addStart + k].text.trim().length)) continue;
      out.set(delStart + k, parts.filter((p) => !p.added).map((p) => ({ text: p.value, hl: !!p.removed })));
      out.set(addStart + k, parts.filter((p) => !p.removed).map((p) => ({ text: p.value, hl: !!p.added })));
    }
  }
  return out;
}

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const shortPath = (p: string) => p.split('/').slice(-3).join('/');
