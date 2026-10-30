import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { Inspector, type Selection } from './components/Inspector.tsx';
import { ActionsContext, nodeTypes, type Actions } from './components/Nodes.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { layout } from './graph/layout.ts';
import { buildIndex, flowModel, impactModel, opTitle } from './graph/model.ts';

type View =
  | { mode: 'flow'; trail: string[]; focus?: string }
  | { mode: 'impact'; op: string; depth: number };

interface IndexEntry {
  id: string;
  title: string;
  mode: string;
  generatedAt: string;
}

const base = import.meta.env.BASE_URL;

function readHash(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
}

function writeHash(graphId: string, view: View) {
  const p = new URLSearchParams({ g: graphId });
  if (view.mode === 'flow') {
    p.set('v', 'flow');
    p.set('t', view.trail.join('|'));
    if (view.focus) p.set('f', view.focus);
  } else {
    p.set('v', 'impact');
    p.set('op', view.op);
    p.set('d', String(view.depth));
  }
  history.replaceState(null, '', `#${p.toString()}`);
}

export default function App() {
  const [graphs, setGraphs] = useState<IndexEntry[]>([]);
  const [graphId, setGraphId] = useState<string>();
  const [g, setG] = useState<ModuleGraph>();
  const [view, setView] = useState<View>();
  const [back, setBack] = useState<View[]>([]);
  const [selection, setSelection] = useState<Selection>();
  const [collapsePassthrough, setCollapse] = useState(true);
  const [showResources, setShowResources] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [canvas, setCanvas] = useState<{ nodes: Node[]; edges: Edge[]; key: string; meta?: { maxDepth: number; shown: number; total: number }; chain?: string[] }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch(`${base}graphs/index.json`)
      .then((r) => r.json())
      .then((list: IndexEntry[]) => {
        setGraphs(list);
        setGraphId(readHash().g ?? list[0]?.id);
      })
      .catch(() => setError('No analyses found. Run `npm run analyze -- --project <dir>` first.'));
  }, []);

  useEffect(() => {
    if (!graphId) return;
    fetch(`${base}graphs/${graphId}.json`)
      .then((r) => r.json())
      .then((data: ModuleGraph) => {
        setG(data);
        setBack([]);
        setExpandedGroups(new Set());
        const h = readHash();
        if (h.g === graphId && h.v === 'flow' && h.t) {
          const trail = h.t.split('|');
          setView({ mode: 'flow', trail, focus: h.f });
          setSelection(data.entryPoints[trail.at(-1)!] ? { type: 'entry', id: trail.at(-1)! } : { type: 'op', id: trail.at(-1)! });
        }
        else if (h.g === graphId && h.v === 'impact' && h.op) {
          setView({ mode: 'impact', op: h.op, depth: Number(h.d ?? 1) });
          setSelection({ type: 'op', id: h.op });
        }
        else {
          const top = data.review.queue.find((q) => data.operations[q.operation]?.change === 'modified') ?? data.review.queue[0];
          if (top) {
            setView({ mode: 'impact', op: top.operation, depth: 1 });
            setSelection({ type: 'op', id: top.operation });
          } else {
            setView({ mode: 'flow', trail: [Object.keys(data.entryPoints)[0]] });
          }
        }
      });
  }, [graphId]);

  const index = useMemo(() => (g ? buildIndex(g) : undefined), [g]);

  const viewRef = useRef<View>(undefined);
  viewRef.current = view;
  const chainRef = useRef<string[]>(undefined);
  chainRef.current = canvas?.chain;
  const navigate = useCallback((next: View) => {
    const cur = viewRef.current;
    if (cur) setBack((b) => [...b.slice(-30), cur]);
    setView(next);
  }, []);

  useEffect(() => {
    if (!g || !index || !view || !graphId) return;
    writeHash(graphId, view);
    let cancelled = false;
    if (view.mode === 'flow') {
      const scopeId = view.trail.at(-1)!;
      const model = flowModel(g, scopeId, { collapsePassthrough, showResources, focusOp: view.focus, focusPath: view.focus ? ancestors(index, view.focus) : undefined });
      for (const n of model.nodes) if (n.type === 'module') n.data.reach = index.reach.get(n.data.opId as string)?.size ?? 0;
      layout(model).then((res) => !cancelled && setCanvas({ ...res, key: `${graphId}|${view.trail.join('>')}|${collapsePassthrough}|${showResources}`, chain: model.chain }));
    } else {
      const model = impactModel(g, index, view.op, { depth: view.depth, groupThreshold: 12, expandedGroups });
      layout(model).then((res) =>
        !cancelled && setCanvas({ ...res, key: `${graphId}|impact|${view.op}|${view.depth}|${[...expandedGroups].join()}`, meta: { maxDepth: model.maxDepth, shown: model.entriesShown, total: model.entriesTotal } }),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [g, index, view, collapsePassthrough, showResources, expandedGroups, graphId]);

  const actions: Actions = useMemo(
    () => ({
      drill: (opId) => {
        const cur = viewRef.current;
        setSelection({ type: 'op', id: opId });
        const trail = cur?.mode === 'flow' ? [...cur.trail.slice(0, -1), ...(chainRef.current ?? cur.trail.slice(-1))] : [];
        navigate({ mode: 'flow', trail: [...trail.filter((t) => t !== opId), opId], focus: cur?.mode === 'flow' ? cur.focus : undefined });
      },
      zoomOut: (opId) => {
        setSelection({ type: 'op', id: opId });
        navigate({ mode: 'impact', op: opId, depth: 1 });
      },
      openEntry: (entryId) => {
        const cur = viewRef.current;
        setSelection({ type: 'entry', id: entryId });
        navigate({ mode: 'flow', trail: [entryId], focus: cur?.mode === 'impact' ? cur.op : cur?.mode === 'flow' ? cur.focus : undefined });
      },
      expandGroup: (gid) => setExpandedGroups((s) => new Set([...s, gid])),
    }),
    [navigate],
  );

  if (error) return <div className="splash">{error}</div>;
  if (!g || !index || !view) return <div className="splash">Loading…</div>;

  const onNodeClick = (_: unknown, node: Node) => {
    const d = node.data as Record<string, string>;
    if (d.opId) setSelection({ type: 'op', id: d.opId });
    else if (d.entryId) setSelection({ type: 'entry', id: d.entryId });
    else if (node.type === 'resource') setSelection({ type: 'resource', id: node.id });
    else if (node.id === '__entry' && view.mode === 'flow' && g.entryPoints[view.trail[0]] && view.trail.length === 1) setSelection({ type: 'entry', id: view.trail[0] });
  };
  const onNodeDoubleClick = (_: unknown, node: Node) => {
    const d = node.data as Record<string, string>;
    if (d.opId) actions.drill(d.opId);
    else if (d.entryId) actions.openEntry(d.entryId);
  };

  const label = (id: string) => g.entryPoints[id]?.label ?? opTitle(g, id);

  return (
    <ActionsContext.Provider value={actions}>
      <div className="app">
        <header className="topbar">
          <div className="brand">◇ modulegraph <span className="muted">module-level review</span></div>
          <select value={graphId} onChange={(e) => { setGraphId(e.target.value); history.replaceState(null, '', '#'); }}>
            {graphs.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
          <span className="muted small">{g.service} · {Object.keys(g.modules).length} modules · {Object.keys(g.entryPoints).length} entry points</span>
          <div className="spacer" />
          <label className="small"><input type="checkbox" checked={collapsePassthrough} onChange={(e) => setCollapse(e.target.checked)} /> skip pass-through wrappers</label>
          <label className="small"><input type="checkbox" checked={showResources} onChange={(e) => setShowResources(e.target.checked)} /> show data sources &amp; sinks</label>
        </header>
        <Sidebar g={g} index={index} onSelect={setSelection} />
        <main className="canvas">
          <div className="crumbs">
            <button disabled={!back.length} onClick={() => { setView(back.at(-1)); setBack(back.slice(0, -1)); }}>← back</button>
            {view.mode === 'flow' ? (
              <>
                <span className="mode-tag">flow</span>
                {view.trail.map((id, i) => (
                  <span key={id + i} className="crumb">
                    {i > 0 && <span className="sep">›</span>}
                    <button className="link" onClick={() => navigate({ mode: 'flow', trail: view.trail.slice(0, i + 1), focus: view.focus })}>{label(id)}</button>
                  </span>
                ))}
                {view.focus && (
                  <span className="focus-tag" title="Highlighted because you came here from its zoom-out view">
                    focus: {opTitle(g, view.focus)} <button className="link" onClick={() => setView({ ...view, focus: undefined })}>✕</button>
                  </span>
                )}
                {(canvas?.chain?.length ?? 0) > 1 && (
                  <span className="muted small">
                    {' '}› {canvas!.chain!.slice(1).map((id) => (
                      <button key={id} className="link muted" onClick={() => setSelection({ type: 'op', id })} title="pass-through wrapper, skipped">{label(id)}</button>
                    ))}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="mode-tag impact">zoom out</span>
                <b>{opTitle(g, view.op)}</b>
                <span className="muted small">
                  {' '}{canvas?.meta?.shown ?? 0} of {canvas?.meta?.total ?? 0} entry points shown · {view.depth} level{view.depth > 1 ? 's' : ''} up
                </span>
                <button disabled={view.depth <= 0} onClick={() => setView({ ...view, depth: view.depth - 1 })}>− zoom in</button>
                <button disabled={!!canvas?.meta && view.depth >= canvas.meta.maxDepth} onClick={() => setView({ ...view, depth: view.depth + 1 })}>zoom out +</button>
                <button disabled={!!canvas?.meta && view.depth >= canvas.meta.maxDepth} onClick={() => setView({ ...view, depth: canvas?.meta?.maxDepth ?? 9 })}>all entry points</button>
                {expandedGroups.size > 0 && <button onClick={() => setExpandedGroups(new Set())}>regroup</button>}
              </>
            )}
          </div>
          {canvas && (
            <ReactFlow
              key={canvas.key}
              nodes={canvas.nodes}
              edges={canvas.edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
              minZoom={0.15}
              nodesConnectable={false}
            >
              <Background gap={24} color="#e2e8f0" />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
          <Legend />
        </main>
        <Inspector g={g} index={index} selection={selection} onSelect={setSelection} />
      </div>
    </ActionsContext.Provider>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><i className="sw modified" /> modified</span>
      <span><i className="sw added" /> added</span>
      <span><i className="sw inside" /> changes inside</span>
      <span className="chip fx-read direct">read</span>
      <span className="chip fx-write direct">write</span>
      <span className="chip fx-outbox direct">outbox</span>
      <span className="chip fx-kafka direct">kafka</span>
      <span className="chip fx-http direct">http</span>
      <span className="muted">solid chip = this module · outlined = via submodules · ━ data · ┅ control</span>
    </div>
  );
}

/** Operations that (transitively) call `opId`: the path to highlight in a flow. */
function ancestors(index: ReturnType<typeof buildIndex>, opId: string): Set<string> {
  const out = new Set<string>();
  const queue = [opId];
  while (queue.length) {
    for (const c of index.callers.get(queue.pop()!) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        queue.push(c);
      }
    }
  }
  return out;
}
