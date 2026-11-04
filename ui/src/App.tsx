import { Background, Controls, ReactFlow, useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModuleGraph } from '../../schema/modulegraph.ts';
import { Inspector, type Selection } from './components/Inspector.tsx';
import { expand, fetchLive, isStale, refresh, servedGraphs, type ExpandAction } from './api.ts';
import { DiffPanel } from './components/DiffView.tsx';
import { edgeTypes } from './components/Edges.tsx';
import { ActionsContext, casesOf, ExampleContext, exampleFor, nodeTypes, type Actions } from './components/Nodes.tsx';
import { NodeMenu, type MenuTarget } from './components/NodeMenu.tsx';
import { ReviewBar } from './components/ReviewBar.tsx';
import { layout, type Theme } from './graph/layout.ts';
import { buildIndex, flowModel, impactModel, MODULE_TARGET, opTitle, targetOps } from './graph/model.ts';

type View =
  | { mode: 'flow'; trail: string[]; focus?: string; before?: boolean }
  | { mode: 'impact'; op: string; depth: number };

interface IndexEntry {
  id: string;
  title: string;
  mode: string;
  generatedAt: string;
}

/** What is under review, in words: "feature/x vs main", plus the uncommitted edits when they are included. */
function reviewTarget(g: ModuleGraph): string {
  const s = g.source;
  if (s.mode === 'snapshot') return 'current code, no change';
  if (s.mode === 'uncommitted') return 'uncommitted edits vs HEAD';
  return `${s.head} vs ${s.base}${s.workingTree ? ' + uncommitted edits' : ''}`;
}

/** Same place in the graph (an impact view at any depth, a flow with any focus). */
function viewKey(v: View): string {
  return v.mode === 'impact' ? `impact|${v.op}` : `flow|${v.trail.join('>')}`;
}

/**
 * The path from the change you started at to where you are. Going somewhere already on the path cuts it back
 * there, so it never loops and every step stays one click away.
 */
function extendPath(path: View[], next: View): View[] {
  const at = path.findIndex((v) => viewKey(v) === viewKey(next));
  return at >= 0 ? [...path.slice(0, at), next] : [...path, next];
}

/** The view still makes sense after a refresh: drop what the new code no longer has. */
function stillValid(g: ModuleGraph, view: View): View | undefined {
  const exists = (id: string) => !!(g.entryPoints[id] ?? g.operations[id] ?? (id.startsWith(MODULE_TARGET) && g.modules[id.slice(MODULE_TARGET.length)]));
  if (view.mode === 'impact') return exists(view.op) ? view : undefined;
  const keep = view.trail.findIndex((id) => !exists(id));
  const trail = keep < 0 ? view.trail : view.trail.slice(0, keep);
  return trail.length ? { ...view, trail, focus: view.focus && exists(view.focus) ? view.focus : undefined } : undefined;
}

const base = import.meta.env.BASE_URL;
const FIT = { padding: 0.12, maxZoom: 1.4 };

/** Refit the graph whenever the canvas changes size (window resize, panels shown/hidden). */
function FitOnResize() {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const el = document.querySelector('.canvas .react-flow');
    if (!el) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView(FIT));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitView]);
  return null;
}

function readHash(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
}

/** Browser history entries this app owns. `guard` sits below the first view so one stray Back doesn't leave the page. */
type HistState = { mg: 'view'; graphId: string; view: View; idx: number; path?: View[] } | { mg: 'guard' };

function hashFor(graphId: string, view: View): string {
  const p = new URLSearchParams({ g: graphId });
  if (view.mode === 'flow') {
    p.set('v', 'flow');
    p.set('t', view.trail.join('|'));
    if (view.focus) p.set('f', view.focus);
    if (view.before) p.set('b', '1');
  } else {
    p.set('v', 'impact');
    p.set('op', view.op);
    p.set('d', String(view.depth));
  }
  return `#${p.toString()}`;
}

export default function App() {
  const [graphId, setGraphId] = useState<string>();
  /** The code changed since the last analysis (checked when the window regains focus, and every few seconds). */
  const [stale, setStale] = useState(false);
  const [g, setG] = useState<ModuleGraph>();
  const [view, setView] = useState<View>();
  const [canGoBack, setCanGoBack] = useState(false);
  const [toast, setToast] = useState<string>();
  const [diffFor, setDiffFor] = useState<string>();
  /** Lazy graphs: the analysis server is reachable, so unanalyzed parts can be expanded. */
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [selection, setSelection] = useState<Selection>();
  const [collapsePassthrough, setCollapse] = useState(true);
  const [showResources, setShowResources] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [canvas, setCanvas] = useState<{ nodes: Node[]; edges: Edge[]; key: string; meta?: { maxDepth: number; shown: number; total: number; frontier: string[] }; chain?: string[]; addedCount?: number }>();
  const [error, setError] = useState<string>();
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('modulegraph-theme') as Theme) ?? 'dark');
  /** The example request every node shows (one scenario request, followed through every module it reached). */
  const [caseId, setCaseId] = useState<string>();
  /** How you got here from the change you started at: every step is a view you can click back to. */
  const [path, setPath] = useState<View[]>([]);
  /** Right-click menu on a node. */
  const [menu, setMenu] = useState<MenuTarget>();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('modulegraph-theme', theme);
  }, [theme]);

  useEffect(() => {
    // One review at a time: the one in the link, else the one the analysis server is serving, else the latest saved.
    const fromLink = readHash().g;
    Promise.all([servedGraphs(), fetch(`${base}graphs/index.json`).then((r) => r.json() as Promise<IndexEntry[]>).catch(() => [] as IndexEntry[])])
      .then(([served, list]) => {
        const id = fromLink ?? served[0] ?? list[0]?.id;
        if (id) setGraphId(id);
        else setError('Nothing to review yet. Run `npm run review -- --project <service dir> --base main`.');
      });
  }, []);

  useEffect(() => {
    if (!graphId) return;
    fetch(`${base}graphs/${graphId}.json`)
      .then((r) => r.json())
      .then((data: ModuleGraph) => {
        setG(data);
        setLive(false);
        if (data.lazy) {
          fetchLive(data, graphId).then((fresh) => {
            if (!fresh) return;
            setG(fresh);
            setLive(true);
          });
        }
        setExpandedGroups(new Set());
        const h = readHash();
        if (h.g === graphId && h.v === 'flow' && h.t) {
          const trail = h.t.split('|');
          setView({ mode: 'flow', trail, focus: h.f, before: h.b === '1' || undefined });
        }
        else if (h.g === graphId && h.v === 'impact' && h.op) {
          setView({ mode: 'impact', op: h.op, depth: Number(h.d ?? 1) });
        }
        else {
          const top = data.review.queue.find((q) => data.operations[q.operation]?.change === 'modified') ?? data.review.queue[0];
          if (top) {
            setView({ mode: 'impact', op: top.operation, depth: 1 });
          } else {
            setView({ mode: 'flow', trail: [Object.keys(data.entryPoints)[0]] });
          }
        }
      });
  }, [graphId]);

  const index = useMemo(() => (g ? buildIndex(g) : undefined), [g]);
  const caseLabels = useMemo(() => Object.fromEntries((g?.source.examples?.cases ?? []).map((c) => [c.id, c.label])), [g]);
  const exampleCtx = useMemo(() => ({ caseId, setCase: setCaseId, cases: caseLabels }), [caseId, caseLabels]);

  const graphIdRef = useRef<string>(undefined);
  graphIdRef.current = graphId;
  const gRef = useRef<ModuleGraph>(undefined);
  gRef.current = g;
  const liveRef = useRef(false);
  liveRef.current = live;
  /** Runs one expansion on the analysis server. False when it isn't available. */
  const runExpand = useCallback(async (action: ExpandAction, id: string, what: string): Promise<boolean> => {
    const cur = gRef.current;
    if (!cur?.lazy) return true;
    if (!liveRef.current) {
      // The server may have started after this page loaded: look again before giving up.
      const fresh = await fetchLive(cur, graphIdRef.current!);
      if (!fresh) {
        setToast('This part is not analyzed in the saved file, and the live server is not answering. Run `npm run live` (all live demos), then try again.');
        return false;
      }
      liveRef.current = true;
      setLive(true);
      gRef.current = fresh;
      setG(fresh);
    }
    setBusy(what);
    try {
      setG(await expand(cur, graphIdRef.current!, action, id));
      return true;
    } catch (err) {
      setToast(`Analysis failed: ${String(err)}`);
      return false;
    } finally {
      setBusy(undefined);
    }
  }, []);
  /** Re-analyze after code changes; the server re-reads only changed files. The current view stays open. */
  const runRefresh = useCallback(async () => {
    const cur = gRef.current;
    if (!cur?.lazy) return;
    setBusy('the code that changed');
    try {
      const r = await refresh(cur, graphIdRef.current!);
      setStale(false);
      if (!r.changed) {
        setToast('No code changes since the last analysis.');
        return;
      }
      setG(r.graph);
      const v = viewRef.current && stillValid(r.graph, viewRef.current);
      if (viewRef.current && !v) {
        const top = r.graph.review.queue[0];
        setView(top ? { mode: 'impact', op: top.operation, depth: 1 } : { mode: 'flow', trail: [Object.keys(r.graph.entryPoints)[0]] });
      } else if (v && v !== viewRef.current) setView(v);
      const names = r.files.map((f) => f.split('/').pop());
      setToast(`Re-analyzed in ${(r.ms / 1000).toFixed(1)} s: ${names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} changed` : 'same code, now read from the commit'}${r.baseKept ? '; base side reused' : ''}.`);
    } catch (err) {
      setToast(`Refresh failed: ${String(err)}`);
    } finally {
      setBusy(undefined);
    }
  }, []);

  // While live: notice edits (window focus, and a cheap git check every 5 s) so the refresh button can say so.
  useEffect(() => {
    if (!g?.lazy || !live || !graphId) return;
    let cancelled = false;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void isStale(g, graphId).then((x) => !cancelled && setStale(x));
    };
    check();
    const timer = setInterval(check, 5000);
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [g, live, graphId]);

  // A flow opened from a link, a reload or Back may not be analyzed yet: ask the live server for it once.
  const autoExpanded = useRef(new Set<string>());
  useEffect(() => {
    if (!g?.lazy || !live || view?.mode !== 'flow') return;
    for (const id of view.trail) {
      const entry = g.entryPoints[id];
      const op = g.operations[id];
      const missing = entry ? entry.analysis !== 'full' : op ? !op.lazy?.calleesLoaded : false;
      const key = `${graphId}|${id}`;
      if (!missing || autoExpanded.current.has(key)) continue;
      autoExpanded.current.add(key);
      void runExpand(entry ? 'entry' : 'op', id, entry ? `the flow of ${entry.label}` : `${id} and everything it calls`);
      return;
    }
  }, [g, live, view, graphId, runExpand]);
  const viewRef = useRef<View>(undefined);
  viewRef.current = view;
  const chainRef = useRef<string[]>(undefined);
  chainRef.current = canvas?.chain;
  const maxDepthRef = useRef<number>(undefined);
  maxDepthRef.current = canvas?.meta?.maxDepth;
  /** In-app navigation and the browser's Back/Forward share one history: every view change is a history entry. */
  const histIdx = useRef<number>((history.state as HistState | null)?.mg === 'view' ? (history.state as { idx: number }).idx : 0);
  const nextWrite = useRef<'push' | 'replace' | 'none'>('replace');
  const pathRef = useRef<View[]>([]);
  pathRef.current = path;
  /** The next view starts a new path (a change chip was clicked). */
  const newPath = useRef(false);
  const navigate = useCallback((next: View) => {
    nextWrite.current = 'push';
    setView(next);
  }, []);
  /** Back to a change: its impact view, and the path starts again from it. */
  const goHome = useCallback((opId: string) => {
    newPath.current = true;
    navigate({ mode: 'impact', op: opId, depth: 1 });
  }, [navigate]);

  useEffect(() => {
    const graphId = graphIdRef.current;
    if (!view || !graphId) return;
    const mode = nextWrite.current;
    nextWrite.current = 'replace';
    if (mode === 'none') return;
    const prev = pathRef.current;
    const nextPath = newPath.current || !prev.length ? [view]
      : mode === 'replace' && viewKey(prev.at(-1)!) === viewKey(view) ? [...prev.slice(0, -1), view]
      : extendPath(prev, view);
    newPath.current = false;
    setPath(nextPath);
    const url = hashFor(graphId, view);
    const st = history.state as HistState | null;
    if (mode === 'replace' && st?.mg !== 'view') {
      // First view of this tab: put a guard entry underneath it.
      history.replaceState({ mg: 'guard' } satisfies HistState, '', url);
      histIdx.current = 0;
      history.pushState({ mg: 'view', graphId, view, idx: 0, path: nextPath } satisfies HistState, '', url);
    } else if (mode === 'push') {
      histIdx.current += 1;
      history.pushState({ mg: 'view', graphId, view, idx: histIdx.current, path: nextPath } satisfies HistState, '', url);
    } else {
      history.replaceState({ mg: 'view', graphId, view, idx: histIdx.current, path: nextPath } satisfies HistState, '', url);
    }
    setCanGoBack(histIdx.current > 0);
  }, [view]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = e.state as HistState | null;
      if (st?.mg === 'guard') {
        histIdx.current = -1;
        setCanGoBack(false);
        setToast('This is where the review started. Press Back again to leave modulegraph.');
        return;
      }
      if (st?.mg !== 'view') {
        // A hash edited by hand (or a link to another view): read the view from the URL and adopt the entry.
        const h = readHash();
        const fromHash: View | undefined =
          h.v === 'flow' && h.t ? { mode: 'flow', trail: h.t.split('|'), focus: h.f, before: h.b === '1' || undefined }
          : h.v === 'impact' && h.op ? { mode: 'impact', op: h.op, depth: Number(h.d ?? 1) } : undefined;
        if (h.g && h.g !== graphIdRef.current) {
          nextWrite.current = 'replace';
          setGraphId(h.g);
        } else if (fromHash) {
          nextWrite.current = 'replace';
          histIdx.current += 1;
          setView(fromHash);
        }
        return;
      }
      setToast(undefined);
      histIdx.current = st.idx;
      setCanGoBack(st.idx > 0);
      nextWrite.current = 'none';
      setPath(st.path ?? [st.view]);
      if (st.graphId !== graphIdRef.current) setGraphId(st.graphId);
      else setView(st.view);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // Shift+F12, as in an IDE: show references to the selected module.
  const selectionRef = useRef<Selection>(undefined);
  selectionRef.current = selection;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F12' || !e.shiftKey) return;
      const sel = selectionRef.current;
      if (sel?.type !== 'op') return;
      e.preventDefault();
      nextWrite.current = 'push';
      setView({ mode: 'impact', op: sel.id, depth: 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setMenu(undefined), [view, graphId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDiffFor(undefined);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setDiffFor(undefined), [view, graphId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!g || !index || !view || !graphId) return;
    let cancelled = false;
    if (view.mode === 'flow') {
      const scopeId = view.trail.at(-1)!;
      const model = flowModel(g, scopeId, { collapsePassthrough, showResources, focusOp: view.focus, focusPath: view.focus ? ancestors(index, targetOps(g, view.focus)) : undefined, before: view.before });
      for (const n of model.nodes) if (n.type === 'module') n.data.reach = index.reach.get(n.data.opId as string)?.size ?? 0;
      // Keep following the same request when this flow was part of it (drilling in from a caller); else its first.
      const shown = model.nodes.find((n) => n.id === '__entry')?.data.examples as Parameters<typeof exampleFor>[0];
      if (shown?.length) setCaseId((cur) => (exampleFor(shown, cur) ? cur : casesOf(shown[0], 0)[0]));
      layout(model, theme).then((res) => !cancelled && setCanvas({ ...res, key: `${graphId}|${view.trail.join('>')}|${view.before ? 'before' : 'now'}|${collapsePassthrough}|${showResources}|${theme}|${Object.keys(g.scopes).length}`, chain: model.chain, addedCount: model.addedCount }));
    } else {
      const model = impactModel(g, index, view.op, { depth: view.depth, groupThreshold: 12, expandedGroups });
      if (view.depth > model.maxDepth && model.maxDepth > 0) {
        setView({ ...view, depth: model.maxDepth });
        return;
      }
      layout(model, theme).then((res) =>
        !cancelled && setCanvas({ ...res, key: `${graphId}|impact|${view.op}|${view.depth}|${[...expandedGroups].join()}|${theme}|${Object.keys(g.scopes).length}`, meta: { maxDepth: model.maxDepth, shown: model.entriesShown, total: model.entriesTotal, frontier: model.frontier } }),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [g, index, view, collapsePassthrough, showResources, expandedGroups, graphId, theme]);

  const actions: Actions = useMemo(
    () => ({
      drill: async (opId) => {
        const cg = gRef.current;
        const op = cg?.operations[opId];
        if (cg?.lazy && !op?.lazy?.calleesLoaded) {
          const ok = await runExpand('op', opId, `${opId} and everything it calls`);
          if (!ok && !op) return;
        }
        const cur = viewRef.current;
        const trail = cur?.mode === 'flow' ? [...cur.trail.slice(0, -1), ...(chainRef.current ?? cur.trail.slice(-1))] : [];
        navigate({ mode: 'flow', trail: [...trail.filter((t) => t !== opId), opId], focus: cur?.mode === 'flow' ? cur.focus : undefined, before: cur?.mode === 'flow' ? cur.before : undefined });
      },
      zoomOut: (opId) => {
        const cur = viewRef.current;
        // Already zoomed out from this module: go one more level up instead of re-opening the same view.
        if (cur?.mode === 'impact' && cur.op === opId) {
          setView({ ...cur, depth: Math.min(cur.depth + 1, maxDepthRef.current ?? cur.depth + 1) });
          return;
        }
        navigate({ mode: 'impact', op: opId, depth: 1 });
      },
      references: (target) => navigate({ mode: 'impact', op: target, depth: 1 }),
      openEntry: async (entryId) => {
        const cg = gRef.current;
        if (cg?.lazy && cg.entryPoints[entryId]?.analysis !== 'full') {
          const ok = await runExpand('entry', entryId, `the flow of ${cg.entryPoints[entryId]?.label ?? entryId}`);
          if (!ok && !cg.scopes[entryId]) return;
        }
        const cur = viewRef.current;
        navigate({ mode: 'flow', trail: [entryId], focus: cur?.mode === 'impact' ? cur.op : cur?.mode === 'flow' ? cur.focus : undefined });
      },
      expandGroup: (gid) => setExpandedGroups((s) => new Set([...s, gid])),
      showDiff: (id) => setDiffFor(id),
      loadCallers: async (opIds) => {
        for (const id of opIds) if (!(await runExpand('callers', id, `callers of ${id}`))) return;
      },
    }),
    [navigate, runExpand],
  );

  if (error) return <div className="splash">{error}</div>;
  if (!g || !index || !view) return <div className="splash">Loading…</div>;

  const selectionFor = (node: Node): Selection => {
    const d = node.data as Record<string, string>;
    if (d.opId) return { type: 'op', id: d.opId };
    if (d.entryId) return { type: 'entry', id: d.entryId };
    if (node.type === 'resource') return { type: 'resource', id: node.id };
    if (node.id === '__entry' && view.mode === 'flow' && g.entryPoints[view.trail[0]] && view.trail.length === 1) return { type: 'entry', id: view.trail[0] };
    if (node.id === '__entry' && view.mode === 'flow' && g.operations[view.trail.at(-1)!]) return { type: 'op', id: view.trail.at(-1)! };
    return undefined;
  };
  const onNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    const d = node.data as { opId?: string; opIds?: string[]; entryId?: string };
    const sel = selectionFor(node);
    const opIds = d.opIds ?? (d.opId ? [d.opId] : sel?.type === 'op' ? [sel.id] : undefined);
    const entryId = d.entryId ?? (sel?.type === 'entry' ? sel.id : undefined);
    const box = (e.currentTarget as HTMLElement).closest('.canvas')!.getBoundingClientRect();
    setMenu({ x: e.clientX - box.left, y: e.clientY - box.top, opIds, entryId, resourceId: node.type === 'resource' ? node.id : undefined, selection: sel });
  };
  const onNodeClick = (_: unknown, node: Node) => {
    const sel = selectionFor(node);
    if (sel) setSelection(sel);
  };
  const onNodeDoubleClick = (_: unknown, node: Node) => {
    const d = node.data as Record<string, string>;
    if (d.opId) actions.drill(d.opId);
    else if (d.entryId) actions.openEntry(d.entryId);
  };

  const label = (id: string) => g.entryPoints[id]?.label ?? opTitle(g, id);

  return (
    <ActionsContext.Provider value={actions}>
     <ExampleContext.Provider value={exampleCtx}>
      <div className={`app no-left ${selection ? '' : 'no-right'}`}>
        <header className="topbar">
          <div className="brand">◇ modulegraph <span className="muted">module-level review</span></div>
          <div className="review-title" title={[g.source.title, g.source.analyzer && `Analyzed as ${g.source.analyzer.language}: ${g.source.analyzer.frameworks.map((f) => `${f.name} (${f.reason})`).join(', ')}`, g.review.reviewers.length ? `Owners: ${g.review.reviewers.join(', ')}` : ''].filter(Boolean).join('\n')}>
            <div className="review-name">{g.source.title ?? reviewTarget(g)}</div>
            <div className="muted small">{reviewTarget(g)} · {g.service}{g.source.analyzer?.frameworks.length ? ` (${g.source.analyzer.frameworks.map((f) => f.name).join(', ')})` : ''} · {Object.keys(g.modules).length} modules · {Object.keys(g.entryPoints).length} entry points{g.review.reviewers.length ? ` · owners ${g.review.reviewers.join(', ')}` : ''}</div>
          </div>
          {g.lazy && live && (
            <button className={`refresh ${stale ? 'stale' : ''}`} disabled={!!busy} onClick={() => void runRefresh()}
              title={stale ? 'The code changed since this was analyzed. Re-analyze: only the changed files are read again.' : 'Re-analyze after editing or committing. Only the files that changed are read again.'}>
              ↻ {stale ? 'code changed: refresh' : 'refresh'}
            </button>
          )}
          {g.lazy && (
            <span className={`lazy-badge ${live ? 'live' : ''}`}
              title={live
                ? 'Lazy analysis, live: only what this review needed is analyzed. Opening a flow, drilling in or loading callers analyzes more on demand.'
                : 'Lazy analysis, saved file: shows what was analyzed so far. Run `npm run live` to expand the rest.'}>
              {live ? '● live' : '○ saved'} · {g.lazy.stats.entryPointsAnalyzed} of {g.lazy.stats.entryPointsKnown} flows analyzed
            </span>
          )}
          <div className="spacer" />
          <label className="small"><input type="checkbox" checked={collapsePassthrough} onChange={(e) => setCollapse(e.target.checked)} /> skip pass-through wrappers</label>
          <label className="small"><input type="checkbox" checked={showResources} onChange={(e) => setShowResources(e.target.checked)} /> show data sources &amp; sinks</label>
          <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle dark mode">
            {theme === 'dark' ? '☀ light' : '☾ dark'}
          </button>
        </header>
        <main className="canvas">
          <ReviewBar g={g} home={path[0]?.mode === 'impact' ? path[0].op : undefined} onHome={goHome} />
          <div className="crumbs">
            <button disabled={!canGoBack} onClick={() => history.back()} title="Same as the browser's Back button">← back</button>
            {path.slice(0, -1).map((v, i) => (
              <span key={viewKey(v)} className="path-step">
                <button className="path-chip" onClick={() => navigate(v)} title={v.mode === 'impact' ? `Impact view: everything that calls ${opTitle(g, v.op)}` : `Flow view: ${v.trail.map(label).join(' › ')}`}>
                  <span className={`mini-tag ${v.mode}`}>{v.mode}</span>{v.mode === 'impact' ? opTitle(g, v.op) : label(v.trail.at(-1)!)}
                </button>
                <span className="sep">→</span>
              </span>
            ))}
            {view.mode === 'flow' ? (
              <>
                <span className="mode-tag" title="Flow view: one entry point or operation, step by step, module by module">flow</span>
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
                {(() => {
                  const scopeId = canvas?.chain?.at(-1) ?? view.trail.at(-1)!;
                  const n = (g.operations[scopeId]?.changes ?? g.entryPoints[scopeId]?.changes)?.length ?? 0;
                  const owner = g.operations[scopeId] ?? g.entryPoints[scopeId];
                  // Now / before: the same flow as on the base revision, for a modified operation or entry point.
                  const canCompare = owner?.change === 'modified' && g.source.mode !== 'snapshot';
                  const steps = g.scopes[scopeId]?.before ? 'steps differ' : 'same steps; code inside changed';
                  const base = g.source.base ?? 'HEAD';
                  return (
                    <>
                      {(canCompare || view.before) && (
                        <span className="seg" title={`Compare this flow with ${base}: ${steps}`}>
                          <button className={view.before ? '' : 'on'} onClick={() => setView({ ...view, before: undefined })}>now</button>
                          <button className={view.before ? 'on before' : ''} onClick={() => setView({ ...view, before: true })}>before</button>
                        </span>
                      )}
                      {n ? <button className="diff-crumb" onClick={() => setDiffFor(scopeId)} title="Code changes behind this flow, function by function">code changes ± ({n})</button> : null}
                      {view.before && (
                        <span className="before-note">
                          as on {base}{canCompare ? `: ${steps}` : ''}{canvas?.addedCount ? ` · ${canvas.addedCount} step${canvas.addedCount > 1 ? 's' : ''} this change adds not shown` : ''} · examples hidden (recorded on the new code)
                        </span>
                      )}
                    </>
                  );
                })()}
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
                <span className="mode-tag impact" title="Impact view: this module and everything that calls it, up to the entry points">impact</span>
                <b>{opTitle(g, view.op)}</b>
                <span className="muted small">
                  {' '}{canvas?.meta?.shown ?? 0} of {canvas?.meta?.total ?? 0} entry points shown · {view.depth} level{view.depth > 1 ? 's' : ''} up
                </span>
                <button disabled={view.depth <= 0} onClick={() => setView({ ...view, depth: view.depth - 1 })}>− zoom in</button>
                <button
                  disabled={!!canvas?.meta && view.depth >= canvas.meta.maxDepth && !canvas.meta.frontier.length}
                  onClick={async () => {
                    if (canvas?.meta && view.depth >= canvas.meta.maxDepth && canvas.meta.frontier.length) await actions.loadCallers(canvas.meta.frontier);
                    setView({ ...view, depth: view.depth + 1 });
                  }}>zoom out +</button>
                <button
                  disabled={!!canvas?.meta && view.depth >= canvas.meta.maxDepth && !canvas.meta.frontier.length}
                  onClick={async () => {
                    for (const op of g.lazy ? targetOps(g, view.op) : []) if (!(await runExpand('reach', op, `every entry point that reaches ${opTitle(g, op)}`))) return;
                    setView({ ...view, depth: 99 });
                  }}>all entry points</button>
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
              edgeTypes={edgeTypes}
              colorMode={theme}
              nodesDraggable={false}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeContextMenu={onNodeContextMenu}
              onPaneClick={() => setSelection(undefined)}
              fitView
              fitViewOptions={FIT}
              minZoom={0.15}
              nodesConnectable={false}
            >
              <Background gap={24} color={theme === 'dark' ? '#1e293b' : '#e2e8f0'} />
              <Controls showInteractive={false} fitViewOptions={FIT} />
              <FitOnResize />
            </ReactFlow>
          )}
          {menu && <NodeMenu g={g} at={menu} onClose={() => setMenu(undefined)} onDetails={() => setSelection(menu.selection)} />}
          <Legend />
          {toast && <div className="toast">{toast}</div>}
          {busy && <div className="busy">⏳ analyzing {busy}…</div>}
          {diffFor && (g.operations[diffFor]?.changes ?? g.entryPoints[diffFor]?.changes)?.length ? (
            <DiffPanel title={label(diffFor)} changes={(g.operations[diffFor]?.changes ?? g.entryPoints[diffFor]?.changes)!} onClose={() => setDiffFor(undefined)} />
          ) : null}
        </main>
        {selection && <Inspector g={g} selection={selection} onClose={() => setSelection(undefined)} />}
      </div>
     </ExampleContext.Provider>
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
      <span className="chip fx-queue direct">queue</span>
      <span className="chip fx-event direct">event</span>
      <span><span className="legend-decision">◇</span> exclusive branch (yes / no)</span>
      <span className="muted">solid chip = this module · outlined = via submodules · ━ data · ┅ control</span>
    </div>
  );
}

/** Operations that (transitively) call these: the path to highlight in a flow. */
function ancestors(index: ReturnType<typeof buildIndex>, opIds: string[]): Set<string> {
  const out = new Set<string>();
  const queue = [...opIds];
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
