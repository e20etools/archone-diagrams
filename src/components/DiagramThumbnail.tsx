import { memo, useMemo } from "react";
import { NODE_H, NODE_W } from "@/lib/layout";
import { diagramPicture } from "@/lib/export/picture";
import type { Diagram, Workspace } from "@/lib/types";
import { TypeIcon } from "./icons";

/** The size a thumbnail is drawn at on a card, used to decide whether names can be read. */
const NOMINAL_W = 300;
const NOMINAL_H = 225;
const NAME_SIZE = 30;

/**
 * A diagram drawn small: its boxes where the diagram puts them, coloured by category, with
 * the lines, zones and boundary between them. Names are written in when they would be large
 * enough to read; otherwise each box shows its icon and two quiet lines in place of text.
 */
export const DiagramThumbnail = memo(function DiagramThumbnail({ ws, diagram }: { ws: Workspace; diagram: Diagram }) {
  const picture = useMemo(() => diagramPicture(ws, diagram), [ws, diagram]);
  if (!picture.nodes.length) {
    return (
      <span className="grid size-full place-items-center text-xs text-ink-faint" data-thumbnail-empty>
        Empty diagram
      </span>
    );
  }
  const pad = 28;
  const minX = Math.min(...picture.nodes.map((n) => n.x), ...picture.zones.map((z) => z.x), picture.boundary?.x ?? Infinity) - pad;
  const minY = Math.min(...picture.nodes.map((n) => n.y), ...picture.zones.map((z) => z.y), picture.boundary?.y ?? Infinity) - pad;
  const maxX = Math.max(...picture.nodes.map((n) => n.x + n.w), ...picture.zones.map((z) => z.x + z.w), picture.boundary ? picture.boundary.x + picture.boundary.w : -Infinity) + pad;
  const maxY = Math.max(...picture.nodes.map((n) => n.y + n.h), ...picture.zones.map((z) => z.y + z.h), picture.boundary ? picture.boundary.y + picture.boundary.h : -Infinity) + pad;
  // A diagram with one or two boxes would otherwise fill the card edge to edge.
  const width = Math.max(maxX - minX, NODE_W * 2.4);
  const height = Math.max(maxY - minY, NODE_H * 3);
  const x0 = minX - (width - (maxX - minX)) / 2;
  const y0 = minY - (height - (maxY - minY)) / 2;
  const scale = Math.min(NOMINAL_W / width, NOMINAL_H / height);
  const readable = NAME_SIZE * scale >= 6.5;
  const objects = ws.objects;

  return (
    <svg viewBox={`${x0} ${y0} ${width} ${height}`} preserveAspectRatio="xMidYMid meet" className="size-full" role="img" aria-label={`${diagram.name}: ${picture.nodes.length} boxes`} data-thumbnail={diagram.id}>
      {picture.zones.map((z) => (
        <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} rx={18} fill={z.color} fillOpacity={0.07} stroke={z.color} strokeOpacity={0.45} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      {picture.boundary && (
        <rect x={picture.boundary.x} y={picture.boundary.y} width={picture.boundary.w} height={picture.boundary.h} rx={16} fill="none" className="stroke-ink-faint" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      )}
      {picture.edges.map((e) => (
        <line key={e.id} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} className={e.color ? undefined : "stroke-ink-faint"} stroke={e.color} strokeWidth={e.color ? 1.5 : 1.1} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
      {picture.nodes.map((n) => {
        const o = objects[n.id];
        return (
          <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
            <rect width={n.w} height={n.h} rx={12} className="fill-surface" stroke={n.color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
            <rect width={10} height={n.h} rx={5} fill={n.color} />
            <g transform={`translate(26 ${n.h / 2 - 20})`} color={n.color}>
              <TypeIcon typeId={o?.typeId ?? "service"} componentId={o?.componentId} size={40} />
            </g>
            {readable ? (
              <text x={80} y={n.h / 2 + NAME_SIZE * 0.35} fontSize={NAME_SIZE} fontWeight={600} className="fill-ink">
                {n.name.length > 11 ? `${n.name.slice(0, 10)}…` : n.name}
              </text>
            ) : (
              <>
                <rect x={80} y={n.h / 2 - 16} width={Math.min(110, 30 + n.name.length * 7)} height={12} rx={6} className="fill-ink-faint" fillOpacity={0.55} />
                <rect x={80} y={n.h / 2 + 6} width={70} height={10} rx={5} className="fill-ink-faint" fillOpacity={0.3} />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
});
