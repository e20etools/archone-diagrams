import { describe, expect, it } from "vitest";
import { alignNodes, distributeNodes } from "./arrange";
import { NODE_H, NODE_W } from "./layout";

const at = { a: { x: 0, y: 10 }, b: { x: 300, y: 50 }, c: { x: 90, y: 200 }, d: { x: 1000, y: 1000 } };

describe("arranging picked boxes", () => {
  it("lines boxes up on an edge or on the middle, and returns only those that move", () => {
    expect(alignNodes(at, ["a", "b", "c"], "left")).toEqual({ b: { x: 0, y: 50 }, c: { x: 0, y: 200 } });
    expect(alignNodes(at, ["a", "b", "c"], "right")).toEqual({ a: { x: 300, y: 10 }, c: { x: 300, y: 200 } });
    expect(alignNodes(at, ["a", "b"], "center")).toEqual({ a: { x: 150, y: 10 }, b: { x: 150, y: 50 } });
    expect(alignNodes(at, ["a", "b", "c"], "top")).toEqual({ b: { x: 300, y: 10 }, c: { x: 90, y: 10 } });
    expect(alignNodes(at, ["a", "c"], "bottom")).toEqual({ a: { x: 0, y: 200 } });
    expect(alignNodes(at, ["a", "c"], "middle")).toEqual({ a: { x: 0, y: 105 }, c: { x: 90, y: 105 } });
    expect(alignNodes(at, ["a"], "left")).toEqual({});
    expect(alignNodes(at, ["a", "a", "gone"], "left")).toEqual({});
  });

  it("spaces boxes evenly between the outermost two", () => {
    const wide = { a: { x: 0, y: 0 }, b: { x: 100, y: 5 }, c: { x: 900, y: 9 }, d: { x: 1200, y: 0 } };
    expect(distributeNodes(wide, ["a", "b", "c", "d"], "horizontal")).toEqual({ b: { x: 400, y: 5 }, c: { x: 800, y: 9 } });
    expect(distributeNodes(wide, ["a", "b"], "horizontal")).toEqual({});
  });

  it("keeps a gap when the boxes would otherwise touch", () => {
    const tight = { a: { x: 0, y: 0 }, b: { x: 10, y: 20 }, c: { x: 20, y: 40 } };
    const across = distributeNodes(tight, ["a", "b", "c"], "horizontal");
    expect(across).toEqual({ b: { x: NODE_W + 24, y: 20 }, c: { x: 2 * (NODE_W + 24), y: 40 } });
    const down = distributeNodes(tight, ["c", "a", "b"], "vertical");
    expect(down).toEqual({ b: { x: 10, y: NODE_H + 24 }, c: { x: 20, y: 2 * (NODE_H + 24) } });
  });
});
