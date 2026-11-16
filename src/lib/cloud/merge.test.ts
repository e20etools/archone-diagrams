import { describe, expect, it } from "vitest";
import type { ModelObject, Relationship } from "../types";
import { mergeChange, mergeItems } from "./merge";
import { emptyTables, nodeKey, patchTables, withoutDangling, type DiagramMeta, type Tables } from "./tables";

const T0 = "2026-01-01T00:00:00.000Z";
const SINCE = "2026-02-01T00:00:00.000Z";
const LATER = "2026-03-01T00:00:00.000Z";

const object = (id: string, name: string, at = T0, more: Partial<ModelObject> = {}): ModelObject => ({
  id, typeId: "service", name, description: "", owner: "", lifecycle: "active", tags: [], parentId: null, technology: "", fields: {}, provenance: { origin: "manual" }, createdAt: at, updatedAt: at, ...more,
});
const link = (id: string, sourceId: string, targetId: string, at = T0, more: Partial<Relationship> = {}): Relationship => ({
  id, sourceId, targetId, kind: "calls", label: "", protocol: "", port: "", description: "", provenance: { origin: "manual" }, createdAt: at, updatedAt: at, ...more,
});
const diagram = (id: string, name: string, at = T0): DiagramMeta => ({ id, name, description: "", viewType: "custom", scopeId: null, direction: "LR", hiddenRelationshipIds: [], edgeKinds: null, colorBy: "type", createdAt: at, updatedAt: at });

function start(): Tables {
  return {
    ...emptyTables(),
    objects: { web: object("web", "Web shop"), pay: object("pay", "Payments"), old: object("old", "Old gateway") },
    relationships: { r1: link("r1", "web", "pay"), r2: link("r2", "pay", "old") },
    diagrams: { d1: diagram("d1", "Overview") },
    nodes: { [nodeKey("d1", "web")]: { x: 0, y: 0, pinned: false }, [nodeKey("d1", "pay")]: { x: 200, y: 0, pinned: false }, [nodeKey("d1", "old")]: { x: 400, y: 0, pinned: false } },
  };
}
const sides = (main: Tables, scenario: Tables) => Object.fromEntries(mergeItems(main, scenario, SINCE).map((i) => [i.key, `${i.kind} ${i.side}`]));
const apply = (main: Tables, scenario: Tables, keys: string[]) => withoutDangling(patchTables(main, mergeChange(main, scenario, keys).change));

describe("bringing a scenario into its main model", () => {
  it("tells the scenario's work from the main model moving on, and from both changing the same thing", () => {
    const main = start();
    const scenario = start();
    scenario.objects.pay = object("pay", "Payments platform", T0, { updatedAt: LATER });
    scenario.objects.bus = object("bus", "Event bus", LATER);
    delete scenario.objects.old;
    delete scenario.relationships.r2;
    main.objects.web = object("web", "Storefront", T0, { updatedAt: LATER });
    main.objects.crm = object("crm", "CRM", LATER);
    expect(sides(main, scenario)).toEqual({
      "objects:pay": "changed scenario",
      "objects:bus": "added scenario",
      "objects:old": "removed scenario",
      "relationships:r2": "removed scenario",
      "objects:web": "changed main",
      "objects:crm": "removed main",
    });

    main.objects.pay = object("pay", "Payments core", T0, { updatedAt: LATER });
    main.objects.old = object("old", "Old gateway", T0, { updatedAt: LATER, owner: "Ops" });
    delete main.relationships.r1;
    expect(sides(main, scenario)).toMatchObject({ "objects:pay": "changed both", "objects:old": "removed both", "relationships:r1": "added main" });
    // Without a starting time nothing can be told apart, so everything is offered as the scenario's.
    expect(new Set(mergeItems(main, scenario, null).map((i) => i.side))).toEqual(new Set(["scenario"]));
  });

  it("brings only what is ticked, and leaves the main model's own changes alone", () => {
    const main = start();
    const scenario = start();
    scenario.objects.pay = object("pay", "Payments platform", T0, { updatedAt: LATER });
    scenario.objects.bus = object("bus", "Event bus", LATER);
    main.objects.web = object("web", "Storefront", T0, { updatedAt: LATER });
    const merged = apply(main, scenario, ["objects:pay"]);
    expect(merged.objects.pay.name).toBe("Payments platform");
    expect(merged.objects.web.name).toBe("Storefront");
    expect(merged.objects.bus).toBeUndefined();
    expect(mergeChange(main, scenario, []).change).toEqual({});
  });

  it("brings along what a ticked thing cannot exist without", () => {
    const main = start();
    const scenario = start();
    scenario.objects.zone = object("zone", "Cloud zone", LATER);
    scenario.objects.bus = object("bus", "Event bus", LATER, { parentId: "zone" });
    scenario.relationships.r3 = link("r3", "pay", "bus", LATER);
    scenario.diagrams.d2 = diagram("d2", "Target", LATER);
    scenario.nodes[nodeKey("d2", "bus")] = { x: 5, y: 5, pinned: true };

    const viaLink = mergeChange(main, scenario, ["relationships:r3"]);
    expect(viaLink.brought.sort()).toEqual(["Cloud zone", "Event bus"]);
    expect(Object.keys(viaLink.change.objects ?? {}).sort()).toEqual(["bus", "zone"]);

    const merged = apply(main, scenario, ["diagrams:d2"]);
    expect(merged.diagrams.d2.name).toBe("Target");
    expect(merged.nodes[nodeKey("d2", "bus")]).toEqual({ x: 5, y: 5, pinned: true });
    expect(merged.objects.bus.parentId).toBe("zone");
    expect(mergeChange(main, scenario, ["objects:bus", "objects:zone"]).brought).toEqual([]);
  });

  it("takes the arrows and boxes of a removed object with it, and says how many", () => {
    const main = start();
    const scenario = start();
    delete scenario.objects.old;
    delete scenario.relationships.r2;
    delete scenario.nodes[nodeKey("d1", "old")];
    const result = mergeChange(main, scenario, ["objects:old"]);
    expect(result.dropped).toEqual({ relationships: 1, boxes: 1 });
    expect(result.change).toEqual({ objects: { old: null }, relationships: { r2: null }, nodes: { [nodeKey("d1", "old")]: null } });
  });

  it("makes a ticked diagram look as it does in the scenario", () => {
    const main = start();
    const scenario = start();
    scenario.nodes[nodeKey("d1", "web")] = { x: 50, y: 60, pinned: true };
    delete scenario.nodes[nodeKey("d1", "old")];
    const merged = apply(main, scenario, ["diagrams:d1"]);
    expect(merged.nodes[nodeKey("d1", "web")]).toEqual({ x: 50, y: 60, pinned: true });
    expect(merged.nodes[nodeKey("d1", "old")]).toBeUndefined();
    expect(merged.objects.old).toBeDefined();
    expect(mergeItems(merged, scenario, SINCE)).toEqual([]);
  });
});
