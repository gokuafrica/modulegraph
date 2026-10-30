import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';
import type { Model, VEdge } from './model.ts';

const elk = new ELK();

const edgeStyle: Record<VEdge['kind'], Partial<Edge>> = {
  data: { style: { stroke: '#475569', strokeWidth: 1.6 } },
  control: { style: { stroke: '#94a3b8', strokeWidth: 1.2, strokeDasharray: '5 4' } },
  call: { style: { stroke: '#64748b', strokeWidth: 1.6 } },
  read: { style: { stroke: '#2563eb', strokeWidth: 1.1, strokeDasharray: '2 3' } },
  write: { style: { stroke: '#c2410c', strokeWidth: 1.3, strokeDasharray: '2 3' } },
};

/** Layered left→right layout. Model order is kept so steps read in source order. */
export async function layout(model: Model): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.nodeNode': '34',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
    },
    children: model.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: model.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const pos = new Map(graph.children?.map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  const nodes: Node[] = model.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: pos.get(n.id) ?? { x: 0, y: 0 },
    data: n.data,
    style: { width: n.width },
  }));
  const edges: Edge[] = model.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    type: 'default',
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    labelStyle: { fontSize: 11, fill: '#334155' },
    labelBgStyle: { fill: '#f8fafc' },
    markerEnd: { type: 'arrowclosed', width: 16, height: 16, color: e.kind === 'write' ? '#c2410c' : e.kind === 'read' ? '#2563eb' : '#64748b' },
    animated: e.kind === 'call' && e.highlight,
    ...edgeStyle[e.kind],
  }));
  return { nodes, edges };
}
