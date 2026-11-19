import { describe, expect, it } from "vitest";
import { buildScript, buildStages, scriptTime } from "./buildShow";
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

  it("puts boxes a little apart in one row, goes along it from the left, and names the row", () => {
    const ws = demoWorkspace("Khaled");
    const [a, b, c] = Object.keys(ws.objects).filter((id) => ws.objects[id].typeId === "database").concat(Object.keys(ws.objects)).slice(0, 3);
    const d = { direction: "TB", nodes: { [a]: { x: 0, y: 500 }, [b]: { x: 300, y: 520 }, [c]: { x: 600, y: 500 } } } as unknown as Diagram;
    const stages = buildStages(ws, d);
    expect(stages).toHaveLength(1);
    expect(stages[0].ids).toEqual([a, b, c]);
    expect(stages[0].title).not.toBe("");
  });

  it("raises a left to right diagram from the right, and leaves out zones drawn as frames", () => {
    const ws = demoWorkspace("Khaled");
    const ids = Object.keys(ws.objects).slice(0, 3);
    const d = { direction: "LR", nodes: { [ids[0]]: { x: 0, y: 0 }, [ids[1]]: { x: 400, y: 0 }, [ids[2]]: { x: 800, y: 0 } } } as unknown as Diagram;
    expect(buildStages(ws, d).map((s) => s.ids)).toEqual([[ids[2]], [ids[1]], [ids[0]]]);
    expect(buildStages(ws, d, new Set([ids[1]])).map((s) => s.ids)).toEqual([[ids[2]], [ids[0]]]);
  });

  it("draws a zone before its first box, the outer frame first, and each line once both its ends stand", () => {
    const stages = [{ ids: ["db", "cache"], title: "" }, { ids: ["api"], title: "" }, { ids: ["web"], title: "" }];
    const frames = [
      { id: "zone", holds: new Set(["api", "web"]), area: 100 },
      { id: "scope", holds: new Set(["db", "cache", "api", "web"]), area: 900 },
    ];
    const lines = [
      { id: "l1", source: "api", target: "db" },
      { id: "l2", source: "api", target: "cache" },
      { id: "l3", source: "web", target: "api" },
      { id: "l4", source: "web", target: "nowhere" },
    ];
    const steps = buildScript(stages, frames, lines);
    expect(steps.map((s) => `${s.kind}:${s.id}`)).toEqual(["frame:scope", "place:db", "place:cache", "frame:zone", "place:api", "connect:l1", "connect:l2", "place:web", "connect:l3"]);
    expect(steps[5]).toEqual({ kind: "connect", id: "l1", from: "api", to: "db" });
    expect(scriptTime(steps)).toBeGreaterThan(scriptTime(steps.slice(1)));
  });

  it("builds the sample diagram with every box and every line drawn once", () => {
    const ws = demoWorkspace("Khaled");
    const d = named(ws, "Inside Online store");
    const stages = buildStages(ws, d);
    const ids = stages.flatMap((s) => s.ids);
    const lines = ids.slice(1).map((id, i) => ({ id: `l${i}`, source: id, target: ids[i] }));
    const steps = buildScript(stages, [], lines);
    expect(steps.filter((s) => s.kind === "place")).toHaveLength(ids.length);
    expect(steps.filter((s) => s.kind === "connect").map((s) => s.id).sort()).toEqual(lines.map((l) => l.id).sort());
  });
});
