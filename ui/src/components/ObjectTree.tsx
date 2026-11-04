import { useState } from 'react';

/**
 * Expandable value viewer in the style of the browser devtools console: a one-line preview that opens into
 * one row per key, recursively. Used for recorded example inputs and outputs.
 */
export function ObjectTree({ value, label, open = false, added, removed, flat }: {
  value: unknown;
  /** Render the top-level keys as rows, without a root line (for argument lists and returned objects). */
  flat?: boolean;
  /** Key or parameter name shown before the value. */
  label?: string;
  /** Start expanded (first level only). */
  open?: boolean;
  /** Top-level keys added by the change (highlighted green). */
  added?: Set<string>;
  removed?: Set<string>;
}) {
  return (
    <div className="otree nowheel nodrag" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {flat && isContainer(value) && !Array.isArray(value)
        ? entries(value).map(([k, v]) => <Row key={k} label={k} value={v} mark={added?.has(k) ? '+' : removed?.has(k) ? '-' : undefined} />)
        : <Row value={value} label={label} defaultOpen={open} added={added} removed={removed} />}
    </div>
  );
}

function Row({ value, label, defaultOpen, added, removed, mark }: {
  value: unknown; label?: string; defaultOpen?: boolean; added?: Set<string>; removed?: Set<string>; mark?: '+' | '-';
}) {
  const expandable = isContainer(value) && size(value) > 0;
  const [open, setOpen] = useState(!!defaultOpen && expandable);
  return (
    <div className={`ot-row ${mark === '+' ? 'ot-added' : mark === '-' ? 'ot-removed' : ''}`}>
      <div className={`ot-line ${expandable ? 'ot-toggle' : ''}`} onClick={() => expandable && setOpen(!open)}>
        <span className="ot-caret">{expandable ? (open ? '▾' : '▸') : ''}</span>
        {mark && <span className="ot-mark">{mark}</span>}
        {label !== undefined && <><span className="ot-key">{label}</span><span className="ot-colon">: </span></>}
        {open ? <span className="ot-type">{typeName(value)}</span> : <Preview value={value} />}
      </div>
      {open && (
        <div className="ot-children">
          {entries(value).map(([k, v]) => (
            <Row key={k} label={k} value={v} mark={added?.has(k) ? '+' : removed?.has(k) ? '-' : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function Preview({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (!isContainer(value)) return <Prim value={value} />;
  if (depth > 0) return <span className="ot-type">{Array.isArray(value) ? `Array(${value.length})` : '{…}'}</span>;
  const items = entries(value);
  const shown = items.slice(0, 4);
  const more = items.length > shown.length;
  if (Array.isArray(value)) {
    return (
      <span className="ot-preview">
        <span className="ot-type">({value.length}) </span>[
        {shown.map(([k, v], i) => <span key={k}>{i > 0 && ', '}<Preview value={v} depth={depth + 1} /></span>)}
        {more && ', …'}]
      </span>
    );
  }
  return (
    <span className="ot-preview">
      {'{'}
      {shown.map(([k, v], i) => (
        <span key={k}>{i > 0 && ', '}<span className="ot-key">{k}</span>: <Preview value={v} depth={depth + 1} /></span>
      ))}
      {more && ', …'}
      {'}'}
    </span>
  );
}

function Prim({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    const iso = /^\d{4}-\d{2}-\d{2}T/.test(value);
    return <span className={`ot-str ${iso ? 'ot-date' : ''}`}>"{value}"</span>;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return <span className="ot-num">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="ot-bool">{String(value)}</span>;
  if (value === null) return <span className="ot-null">null</span>;
  if (value === undefined) return <span className="ot-null">undefined</span>;
  return <span>{String(value)}</span>;
}

const isContainer = (v: unknown): v is object => typeof v === 'object' && v !== null;
const size = (v: object) => (Array.isArray(v) ? v.length : Object.keys(v).length);
const entries = (v: unknown): [string, unknown][] =>
  Array.isArray(v) ? v.map((x, i) => [String(i), x]) : isContainer(v) ? Object.entries(v as Record<string, unknown>) : [];
const typeName = (v: unknown) => (Array.isArray(v) ? `Array(${v.length})` : 'Object');

/** Short label that tells recorded calls apart: the first input value that differs between them. */
export function exampleLabels(inputs: unknown[]): string[] {
  if (inputs.length < 2) return inputs.map(() => '');
  const leaves = inputs.map((x) => flatten(x));
  const paths = [...new Set(leaves.flatMap((l) => [...l.keys()]))];
  const differing = paths.find((p) => new Set(leaves.map((l) => JSON.stringify(l.get(p)))).size > 1);
  if (!differing) return inputs.map(() => '');
  return leaves.map((l) => {
    const v = l.get(differing);
    const text = typeof v === 'string' ? v : JSON.stringify(v) ?? '–';
    return text.length > 14 ? `${text.slice(0, 13)}…` : text;
  });
}

function flatten(value: unknown, prefix = '', out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (isContainer(value) && depth < 5) {
    for (const [k, v] of entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out.set(prefix, value);
  return out;
}
