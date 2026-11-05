import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';
import type { ElkExtendedEdge, ElkNode } from 'elkjs';
import type { Model, VEdge } from './model.ts';

const elk = new ELK();

export type Theme = 'dark' | 'light';

/** Edge colours per theme. Concrete values, not CSS variables: React Flow derives marker ids from the colour. */
const PALETTE: Record<Theme, Record<VEdge['kind'], string>> = {
  light: { data: '#475569', control: '#94a3b8', call: '#64748b', read: '#2563eb', write: '#c2410c', branch: '#7c3aed', removed: '#dc2626' },
  dark: { data: '#94a3b8', control: '#64748b', call: '#94a3b8', read: '#60a5fa', write: '#fb923c', branch: '#a78bfa', removed: '#f87171' },
};

const DASH: Partial<Record<VEdge['kind'], string>> = { control: '5 4', read: '2 3', write: '2 3', removed: '3 4' };
const WIDTH: Record<VEdge['kind'], number> = { data: 1.6, control: 1.2, call: 1.6, read: 1.1, write: 1.3, branch: 1.6, removed: 1.3 };

/** Layered left→right layout with ELK-routed orthogonal edges (they go around nodes) and placed labels. */
export async function layout(model: Model, theme: Theme): Promise<{ nodes: Node[]; edges: Edge[] }> {
  // Boxes (transactions) are ELK compound nodes sized around their members; coordinates all come back absolute.
  const elkNode = (n: Model['nodes'][number]): ElkNode => n.type === 'txgroup'
    ? { id: n.id, layoutOptions: { 'elk.padding': '[top=34,left=18,bottom=16,right=18]', 'elk.spacing.nodeNode': '24' }, children: model.nodes.filter((c) => c.parent === n.id).map(elkNode) }
    : { id: n.id, width: n.width, height: n.height };
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.layered.spacing.edgeNodeBetweenLayers': '22',
      'elk.spacing.nodeNode': '34',
      'elk.spacing.edgeNode': '18',
      'elk.spacing.edgeEdge': '10',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.json.shapeCoords': 'ROOT',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: model.nodes.filter((n) => !n.parent).map(elkNode),
    edges: model.edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
      labels: e.label ? [{ id: `${e.id}:label`, text: e.label, width: e.label.length * 6.6 + 12, height: 17 }] : [],
    })),
  });
  const placed = new Map<string, ElkNode>();
  const collect = (list?: ElkNode[]) => list?.forEach((c) => (placed.set(c.id, c), collect(c.children)));
  collect(graph.children);
  const pos = new Map([...placed].map(([id, c]) => [id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  const routes = new Map((graph.edges as ElkExtendedEdge[] | undefined)?.map((e) => [e.id, e]));
  const colors = PALETTE[theme];
  const nodes: Node[] = model.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: pos.get(n.id) ?? { x: 0, y: 0 },
    data: n.data,
    // Rendered size = the size ELK routed against, so edges meet the node borders.
    ...(n.type === 'txgroup'
      ? { style: { width: placed.get(n.id)?.width, height: placed.get(n.id)?.height, pointerEvents: 'none' as const }, zIndex: -1, selectable: false, draggable: false }
      : { style: { width: n.width, height: n.height } }),
  }));
  const edges: Edge[] = model.edges.map((e) => {
    const route = routes.get(e.id);
    const section = route?.sections?.[0];
    const label = route?.labels?.[0];
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'elk',
      data: {
        kind: e.kind,
        points: section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : undefined,
        labelPos: label ? { x: label.x ?? 0, y: label.y ?? 0 } : undefined,
      },
      markerEnd: { type: 'arrowclosed', width: 16, height: 16, color: colors[e.kind] },
      animated: e.kind === 'call' && e.highlight,
      style: { stroke: colors[e.kind], strokeWidth: WIDTH[e.kind], strokeDasharray: DASH[e.kind] },
    } as Edge;
  });
  return { nodes, edges };
}
