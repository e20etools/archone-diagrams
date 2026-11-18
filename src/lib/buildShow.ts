import { CATEGORY_INFO, objectType, type Category } from "./catalog";
import { NODE_H, NODE_W } from "./layout";
import type { Diagram, Workspace } from "./types";

/**
 * The order in which the build animation raises a diagram: from the bottom up, one row at a
 * time, so the foundations (data, platforms) stand before what rests on them (services,
 * channels, people). Left to right diagrams rise from the right, where the auto layout puts
 * what the others depend on. Within a row, boxes come in from the middle outwards.
 */

export interface BuildStage {
  ids: string[];
  /** What the row mostly holds, in words: "Data", "Applications and Infrastructure". */
  title: string;
}

/** Rows a little apart still count as one row; boxes placed by hand are rarely exact. */
const ROW_SLACK = 0.5;

const STAGE_NAME: Record<Category, string> = {
  data: "Data and storage",
  infrastructure: "Platforms and infrastructure",
  application: "Applications and services",
  external: "Outside partners",
  people: "People",
  business: "The business",
};

export function buildStages(ws: Workspace, diagram: Pick<Diagram, "nodes" | "direction">, skip: ReadonlySet<string> = new Set()): BuildStage[] {
  const across = diagram.direction === "LR";
  const boxes = Object.entries(diagram.nodes)
    .filter(([id]) => ws.objects[id] && !skip.has(id))
    .map(([id, p]) => ({ id, depth: across ? p.x : p.y, along: across ? p.y : p.x }));
  // Deepest first: the bottom of a top to bottom diagram, the right of a left to right one.
  boxes.sort((a, b) => b.depth - a.depth || a.along - b.along);
  const slack = (across ? NODE_W : NODE_H) * ROW_SLACK;
  const rows: (typeof boxes)[] = [];
  for (const box of boxes) {
    const row = rows.at(-1);
    if (row && row[0].depth - box.depth <= slack) row.push(box);
    else rows.push([box]);
  }
  return rows.map((row) => {
    const mid = (Math.min(...row.map((b) => b.along)) + Math.max(...row.map((b) => b.along))) / 2;
    const ids = [...row].sort((a, b) => Math.abs(a.along - mid) - Math.abs(b.along - mid) || a.along - b.along).map((b) => b.id);
    return { ids, title: titleOf(ws, ids) };
  });
}

function titleOf(ws: Workspace, ids: string[]): string {
  const count = new Map<Category, number>();
  for (const id of ids) {
    const category = objectType(ws.objects[id].typeId).category;
    count.set(category, (count.get(category) ?? 0) + 1);
  }
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "";
  const [first, second] = ranked;
  // A row that is mostly one thing is named for it; an even mix names the two.
  if (!second || first[1] >= second[1] * 2) return STAGE_NAME[first[0]];
  return `${CATEGORY_INFO[first[0]].label} and ${CATEGORY_INFO[second[0]].label.toLowerCase()}`;
}

/** How long a stage holds, in milliseconds: long enough to read its caption, longer for a wider row. */
export const stageTime = (size: number, still: boolean) => (still ? 900 : 1500 + Math.min(size, 8) * 110);
