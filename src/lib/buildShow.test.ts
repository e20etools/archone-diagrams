import { describe, expect, it } from "vitest";
import { buildStages, stageTime } from "./buildShow";
import { demoWorkspace } from "./demo";
import type { Diagram } from "./types";

const named = (ws: ReturnType<typeof demoWorkspace>, name: string) => Object.values(ws.diagrams).find((d) => d.name === name)!;

describe("the build animation's order", () => {
  it("raises a top to bottom diagram from its bottom row up, every box once", () => {
    const ws = demoWorkspace("Khaled");
    const d = named(ws, "Inside Online store");
    const stages = buildStages(ws, d);
    const ids = stages.flatMap((s) => s.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Object.keys(d.nodes).filter((id) => ws.objects[id]).sort());
    const rowY = stages.map((s) => Math.max(...s.ids.map((id) => d.nodes[id].y)));
    expect([...rowY].sort((a, b) => b - a)).toEqual(rowY);
    // The customer stands at the top, so it comes last.
    const customer = Object.values(ws.objects).find((o) => o.name === "Customer")!.id;
    expect(stages.at(-1)!.ids).toContain(customer);
  });

  it("puts boxes a little apart in one row, starts each row in the middle, and names the row", () => {
    const ws = demoWorkspace("Khaled");
    const [a, b, c] = Object.keys(ws.objects).filter((id) => ws.objects[id].typeId === "database").concat(Object.keys(ws.objects)).slice(0, 3);
    const d = { direction: "TB", nodes: { [a]: { x: 0, y: 500 }, [b]: { x: 300, y: 520 }, [c]: { x: 600, y: 500 } } } as unknown as Diagram;
    const stages = buildStages(ws, d);
    expect(stages).toHaveLength(1);
    expect(stages[0].ids[0]).toBe(b);
    expect(stages[0].title).not.toBe("");
  });

  it("raises a left to right diagram from the right, and leaves out zones drawn as frames", () => {
    const ws = demoWorkspace("Khaled");
    const ids = Object.keys(ws.objects).slice(0, 3);
    const d = { direction: "LR", nodes: { [ids[0]]: { x: 0, y: 0 }, [ids[1]]: { x: 400, y: 0 }, [ids[2]]: { x: 800, y: 0 } } } as unknown as Diagram;
    expect(buildStages(ws, d).map((s) => s.ids)).toEqual([[ids[2]], [ids[1]], [ids[0]]]);
    expect(buildStages(ws, d, new Set([ids[1]])).map((s) => s.ids)).toEqual([[ids[2]], [ids[0]]]);
    expect(stageTime(3, false)).toBeGreaterThan(stageTime(3, true));
  });
});
