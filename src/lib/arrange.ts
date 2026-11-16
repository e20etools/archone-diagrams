import { NODE_H, NODE_W } from "./layout";

/** Lining up and spacing out the boxes a person has picked. Every box is the same size. */

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type Axis = "horizontal" | "vertical";
type Point = { x: number; y: number };

const picked = (positions: Record<string, Point>, ids: string[]) => [...new Set(ids)].filter((id) => positions[id]);

/** Moves the picked boxes onto one line. Returns only the boxes that move. */
export function alignNodes(positions: Record<string, Point>, ids: string[], mode: AlignMode): Record<string, Point> {
  const chosen = picked(positions, ids);
  if (chosen.length < 2) return {};
  const xs = chosen.map((id) => positions[id].x);
  const ys = chosen.map((id) => positions[id].y);
  const target: Partial<Point> =
    mode === "left"
      ? { x: Math.min(...xs) }
      : mode === "right"
        ? { x: Math.max(...xs) }
        : mode === "center"
          ? { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2) }
          : mode === "top"
            ? { y: Math.min(...ys) }
            : mode === "bottom"
              ? { y: Math.max(...ys) }
              : { y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };
  const out: Record<string, Point> = {};
  for (const id of chosen) {
    const next = { ...positions[id], ...target };
    if (next.x !== positions[id].x || next.y !== positions[id].y) out[id] = next;
  }
  return out;
}

/**
 * Spaces the picked boxes evenly between the two outermost ones. When that would leave them
 * touching, the outermost box on the far side is pushed out so that a gap remains.
 */
export function distributeNodes(positions: Record<string, Point>, ids: string[], axis: Axis, minGap = 24): Record<string, Point> {
  const key = axis === "horizontal" ? "x" : "y";
  const size = axis === "horizontal" ? NODE_W : NODE_H;
  const chosen = picked(positions, ids).sort((a, b) => positions[a][key] - positions[b][key] || a.localeCompare(b));
  if (chosen.length < 3) return {};
  const first = positions[chosen[0]][key];
  const last = positions[chosen.at(-1)!][key];
  const step = Math.max((last - first) / (chosen.length - 1), size + minGap);
  const out: Record<string, Point> = {};
  chosen.forEach((id, i) => {
    const value = Math.round(first + step * i);
    if (value !== positions[id][key]) out[id] = { ...positions[id], [key]: value };
  });
  return out;
}
