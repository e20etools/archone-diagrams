import { CATEGORY_INFO, objectType, type Category } from "./catalog";
import { NODE_H, NODE_W } from "./layout";
import type { Diagram, Workspace } from "./types";

/**
 * The order in which the build animation puts a diagram together, the way a person would on
 * the canvas: from the bottom up, one row at a time, so the foundations (data, platforms) stand
 * before what rests on them (services, channels, people). Left to right diagrams rise from the
 * right, where the auto layout puts what the others depend on. Within a row, boxes go in from
 * left to right (top to bottom in a left to right diagram).
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
    const ids = [...row].sort((a, b) => a.along - b.along).map((b) => b.id);
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

/** One move of the hand that builds the diagram. */
export type BuildStep =
  /** Draws a zone, or the frame of what the diagram shows the inside of, as a rectangle. */
  | { kind: "frame"; id: string }
  /** Takes a box from the panel and puts it down where it stands. */
  | { kind: "place"; id: string }
  /** Draws a line from one box to another. */
  | { kind: "connect"; id: string; from: string; to: string };

export interface BuildFrame {
  id: string;
  /** The boxes inside it, also those inside a zone within it. */
  holds: ReadonlySet<string>;
  /** Its size on the canvas: a frame around another is drawn first. */
  area: number;
}

/**
 * The moves, in order. Each box goes down in its turn; a zone is drawn just before the first box
 * that goes into it, the outer one first; and each line is drawn as soon as both its ends stand,
 * so a box is wired to what is already there before the next one comes.
 */
export function buildScript(stages: BuildStage[], frames: BuildFrame[], lines: { id: string; source: string; target: string }[]): BuildStep[] {
  const steps: BuildStep[] = [];
  const standing = new Set<string>();
  const drawn = new Set<string>();
  const byEnd = new Map<string, typeof lines>();
  for (const line of lines) for (const end of [line.source, line.target]) byEnd.set(end, [...(byEnd.get(end) ?? []), line]);
  const outerFirst = [...frames].sort((a, b) => b.area - a.area);
  const connect = (id: string) => {
    for (const line of byEnd.get(id) ?? []) {
      if (drawn.has(line.id) || !standing.has(line.source) || !standing.has(line.target)) continue;
      drawn.add(line.id);
      steps.push({ kind: "connect", id: line.id, from: line.source, to: line.target });
    }
  };
  for (const stage of stages)
    for (const id of stage.ids) {
      for (const frame of outerFirst)
        if (!standing.has(frame.id) && frame.holds.has(id)) {
          standing.add(frame.id);
          steps.push({ kind: "frame", id: frame.id });
          connect(frame.id);
        }
      standing.add(id);
      steps.push({ kind: "place", id });
      connect(id);
    }
  return steps;
}

/** Roughly how long the moves take at normal speed, in milliseconds, to keep a large diagram short. */
export const scriptTime = (steps: BuildStep[]) => steps.reduce((ms, step) => ms + (step.kind === "place" ? 1500 : step.kind === "frame" ? 1400 : 1050), 0);
