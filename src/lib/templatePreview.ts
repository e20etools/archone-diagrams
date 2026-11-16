import { typeColor } from "./catalog";
import { NODE_H, NODE_W, autoLayout } from "./layout";
import { sectionById, componentById } from "./library";
import { containers, type Template } from "./templates";

/**
 * A small picture of a template before it is used: its boxes where the layout would put
 * them, coloured by what they are, and the lines between them. Worked out once per template.
 */

export interface PreviewBox {
  key: string;
  x: number;
  y: number;
  color: string;
  icon: string | null;
}
export interface Preview {
  width: number;
  height: number;
  boxes: PreviewBox[];
  lines: { x1: number; y1: number; x2: number; y2: number }[];
}

const cache = new Map<string, Preview>();

export function templatePreview(t: Template): Preview {
  const cached = cache.get(t.id);
  if (cached) return cached;
  const hidden = containers(t);
  const shown = t.objects.filter((o) => !hidden.has(o.key));
  const keys = new Set(shown.map((o) => o.key));
  const edges = t.relationships.filter(([a, b]) => keys.has(a) && keys.has(b)).map(([sourceId, targetId]) => ({ sourceId, targetId }));
  const placed = autoLayout({ nodeIds: shown.map((o) => o.key), edges, direction: t.direction ?? "TB", respectPinned: false });
  const xs = Object.values(placed).map((p) => p.x);
  const ys = Object.values(placed).map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const boxes: PreviewBox[] = shown.map((o) => {
    const c = componentById(o.componentId);
    const section = c ? sectionById(c.sectionId) : undefined;
    return { key: o.key, x: placed[o.key].x - minX, y: placed[o.key].y - minY, color: section?.color ?? typeColor(o.typeId), icon: c?.icon ?? null };
  });
  const at = new Map(boxes.map((b) => [b.key, b]));
  const lines = edges.map(({ sourceId, targetId }) => {
    const a = at.get(sourceId)!;
    const b = at.get(targetId)!;
    return { x1: a.x + NODE_W / 2, y1: a.y + NODE_H / 2, x2: b.x + NODE_W / 2, y2: b.y + NODE_H / 2 };
  });
  const preview: Preview = { width: Math.max(...xs) - minX + NODE_W, height: Math.max(...ys) - minY + NODE_H, boxes, lines };
  cache.set(t.id, preview);
  return preview;
}
