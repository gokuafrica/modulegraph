import { useContext, useEffect, useRef } from 'react';
import type { ModuleGraph } from '../../../schema/modulegraph.ts';
import { MODULE_TARGET, opTitle, targetOps } from '../graph/model.ts';
import type { Selection } from './Inspector.tsx';
import { ActionsContext } from './Nodes.tsx';

export interface MenuTarget {
  x: number;
  y: number;
  /** Operations the node stands for (one, or several when a module node lists them). */
  opIds?: string[];
  entryId?: string;
  resourceId?: string;
  /** What "Details" opens in the inspector. */
  selection?: Selection;
}

/**
 * Right-click menu on any node, like an IDE's: show references (the impact view: who calls this, up to the entry
 * points), for one operation or the whole module, plus drill in, diff and details.
 */
export function NodeMenu({ g, at, onClose, onDetails }: { g: ModuleGraph; at: MenuTarget; onClose: () => void; onDetails: () => void }) {
  const actions = useContext(ActionsContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const items: { label: React.ReactNode; hint?: string; run: () => void; title?: string }[] = [];
  const ops = (at.opIds ?? []).filter((id) => g.operations[id]);
  const moduleId = ops.length ? g.operations[ops[0]].moduleId : undefined;
  const moduleOps = moduleId ? targetOps(g, `${MODULE_TARGET}${moduleId}`) : [];
  for (const id of ops) {
    items.push({
      label: <>Show references to <b>{opTitle(g, id)}()</b></>,
      hint: 'Shift+F12',
      title: 'Impact view: everything that calls this operation, level by level up to the entry points',
      run: run(() => actions.references(id)),
    });
  }
  if (moduleId && moduleOps.length > 1) {
    items.push({
      label: <>Show references to all of <b>{g.modules[moduleId]?.name ?? moduleId}</b> <span className="muted">({moduleOps.length} operations)</span></>,
      title: 'Impact view: everything that calls any operation of this module',
      run: run(() => actions.references(`${MODULE_TARGET}${moduleId}`)),
    });
  }
  if (ops.length === 1) {
    const op = g.operations[ops[0]];
    if ((g.scopes[op.id]?.steps.length ?? 0) > 0 || op.change !== 'unchanged') items.push({ label: 'Drill in', hint: 'double-click', run: run(() => actions.drill(op.id)) });
    if (op.changes?.length) items.push({ label: 'Open diff', run: run(() => actions.showDiff(op.id)) });
  }
  if (at.entryId) {
    items.push({ label: 'Open flow', hint: 'double-click', run: run(() => actions.openEntry(at.entryId!)) });
    if (g.entryPoints[at.entryId]?.changes?.length) items.push({ label: 'Open diff', run: run(() => actions.showDiff(at.entryId!)) });
  }
  items.push({ label: 'Details', hint: 'click', run: run(onDetails) });

  return (
    <div ref={ref} className="node-menu" style={{ left: at.x, top: at.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <button key={i} onClick={it.run} title={it.title}>
          <span>{it.label}</span>
          {it.hint && <span className="muted small">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}
