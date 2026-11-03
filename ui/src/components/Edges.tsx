import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

interface Pt {
  x: number;
  y: number;
}

/** Draws the route ELK computed (around nodes, not through them) with rounded corners, label where ELK put it. */
export function ElkEdge({ id, data, markerEnd, style, label, sourceX, sourceY, targetX, targetY }: EdgeProps) {
  const points = (data?.points as Pt[] | undefined) ?? [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }];
  const labelPos = data?.labelPos as Pt | undefined;
  return (
    <>
      <BaseEdge id={id} path={roundedPath(points, 8)} markerEnd={markerEnd} style={style} />
      {label && labelPos && (
        <EdgeLabelRenderer>
          <div className={`edge-label ${data?.kind ?? ''}`} style={{ transform: `translate(${labelPos.x}px, ${labelPos.y}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function roundedPath(pts: Pt[], radius: number): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p0, p, p1] = [pts[i - 1], pts[i], pts[i + 1]];
    const d0 = Math.hypot(p.x - p0.x, p.y - p0.y) || 1;
    const d1 = Math.hypot(p1.x - p.x, p1.y - p.y) || 1;
    const r = Math.min(radius, d0 / 2, d1 / 2);
    const a = { x: p.x + ((p0.x - p.x) * r) / d0, y: p.y + ((p0.y - p.y) * r) / d0 };
    const b = { x: p.x + ((p1.x - p.x) * r) / d1, y: p.y + ((p1.y - p.y) * r) / d1 };
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

export const edgeTypes = { elk: ElkEdge };
