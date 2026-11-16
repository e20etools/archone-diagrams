import { describe, expect, it } from "vitest";
import { demoWorkspace } from "./demo";
import { impactOf, traverse } from "./graph";
import { NODE_H, NODE_W, autoLayout } from "./layout";
import {
  canSetParent,
  createDiagram,
  createObject,
  createRelationship,
  deleteObject,
  descendantsOf,
  diagramsUsing,
  emptyWorkspace,
  placeNodes,
  updateObject,
} from "./model";
import { parseWorkspace } from "./repository";
import { searchDiagrams, searchObjects } from "./search";
import type { Workspace } from "./types";
import { addObjectsToDiagram, createView, ensureDetailDiagram, relayout, suggestObjects, visibleEdges } from "./views";

function build() {
  let ws: Workspace = emptyWorkspace();
  const ids: Record<string, string> = {};
  const add = (key: string, typeId: string, parent?: string, owner = "") => {
    const made = createObject(ws, { typeId, name: key, parentId: parent ? ids[parent] : null, owner });
    ws = made.ws;
    ids[key] = made.object.id;
  };
  add("Shop", "system", undefined, "Digital");
  add("Web", "web-app", "Shop", "Digital");
  add("Orders", "service", "Shop", "Digital");
  add("OrdersDb", "database", "Shop", "Data");
  add("Billing", "system", undefined, "Finance");
  add("Invoices", "service", "Billing", "Finance");
  add("Cdn", "gateway");
  const link = (s: string, t: string, kind: Parameters<typeof createRelationship>[1]["kind"]) => {
    ws = createRelationship(ws, { sourceId: ids[s], targetId: ids[t], kind }).ws;
  };
  link("Web", "Orders", "calls");
  link("Orders", "OrdersDb", "reads_writes");
  link("Invoices", "Orders", "calls");
  link("Cdn", "Web", "routes_to");
  return { ws, ids, link: (s: string, t: string, k: Parameters<typeof createRelationship>[1]["kind"]) => link(s, t, k), get: () => ws };
}

describe("component model (FR-01, FR-02, FR-04)", () => {
  it("stores an object once and lets several diagrams reference it", () => {
    const { ws, ids } = build();
    let next = createDiagram(ws, { name: "A" }).ws;
    next = createDiagram(next, { name: "B" }).ws;
    const [a, b] = Object.keys(next.diagrams);
    next = placeNodes(next, a, { [ids.Orders]: { x: 0, y: 0, pinned: true } });
    next = placeNodes(next, b, { [ids.Orders]: { x: 50, y: 50, pinned: true } });
    expect(diagramsUsing(next, ids.Orders)).toHaveLength(2);
    // Renaming the object changes it everywhere because diagrams hold references only.
    next = updateObject(next, ids.Orders, { name: "Order service" });
    expect(Object.values(next.objects).filter((o) => o.name === "Order service")).toHaveLength(1);
    expect(next.diagrams[a].nodes[ids.Orders]).toBeDefined();
  });

  it("stores the same relationship once", () => {
    const { ws, ids } = build();
    const again = createRelationship(ws, { sourceId: ids.Web, targetId: ids.Orders, kind: "calls" });
    expect(again.created).toBe(false);
    expect(Object.keys(again.ws.relationships)).toHaveLength(Object.keys(ws.relationships).length);
    expect(createRelationship(ws, { sourceId: ids.Web, targetId: ids.Web }).relationship).toBeNull();
  });

  it("enforces nesting levels and refuses cycles", () => {
    const { ws, ids } = build();
    expect(canSetParent(ws, ids.Orders, "service", ids.Shop)).toBe(true);
    expect(canSetParent(ws, ids.Shop, "system", ids.Orders)).toBe(false); // a system cannot sit inside a service
    expect(canSetParent(ws, ids.Shop, "system", ids.Billing)).toBe(false); // same level
    expect(descendantsOf(ws, ids.Shop).sort()).toEqual([ids.Web, ids.Orders, ids.OrdersDb].sort());
    const moved = updateObject(ws, ids.Orders, { parentId: ids.Cdn });
    expect(moved.objects[ids.Orders].parentId).toBe(ids.Shop); // an invalid parent is refused, the old one stays
  });

  it("deleting an object removes its relationships and nodes and moves its children up", () => {
    const { ws, ids } = build();
    const view = createView(ws, { name: "Inside", viewType: "container", scopeId: ids.Shop });
    const after = deleteObject(view.ws, ids.Shop);
    expect(after.objects[ids.Shop]).toBeUndefined();
    expect(after.objects[ids.Web].parentId).toBeNull();
    expect(after.diagrams[view.diagram.id].scopeId).toBeNull();
    const gone = deleteObject(ws, ids.Orders);
    expect(Object.values(gone.relationships).some((r) => r.sourceId === ids.Orders || r.targetId === ids.Orders)).toBe(false);
  });

  it("rejects unreadable backups and repairs dangling references", () => {
    expect(parseWorkspace({ nope: true })).toBeNull();
    const { ws, ids } = build();
    const broken = JSON.parse(JSON.stringify(ws)) as Workspace;
    delete broken.objects[ids.Orders];
    const repaired = parseWorkspace(broken)!;
    expect(Object.values(repaired.relationships).every((r) => repaired.objects[r.sourceId] && repaired.objects[r.targetId])).toBe(true);
  });
});

describe("views (FR-08, FR-09)", () => {
  it("derives edges from the model and rolls child relationships up to visible parents", () => {
    const { ws, ids } = build();
    const landscape = createView(ws, { name: "Landscape", viewType: "landscape" });
    const edges = visibleEdges(landscape.ws, landscape.diagram);
    // Invoices (inside Billing) calls Orders (inside Shop): shown as Billing -> Shop on the landscape.
    const rolled = edges.find((e) => e.sourceId === ids.Billing && e.targetId === ids.Shop);
    expect(rolled?.implied).toBe(true);
    // Relationships wholly inside Shop are not drawn as a self-loop.
    expect(edges.some((e) => e.sourceId === e.targetId)).toBe(false);
  });

  it("shows the same relationship in every view that contains both ends", () => {
    const { ws, ids } = build();
    const a = createView(ws, { name: "Inside shop", viewType: "container", scopeId: ids.Shop });
    const b = createDiagram(a.ws, { name: "Custom" });
    const filled = addObjectsToDiagram(b.ws, b.diagram.id, [ids.Web, ids.Orders]);
    const inA = visibleEdges(filled, filled.diagrams[a.diagram.id]).find((e) => e.sourceId === ids.Web && e.targetId === ids.Orders);
    const inB = visibleEdges(filled, filled.diagrams[b.diagram.id]).find((e) => e.sourceId === ids.Web && e.targetId === ids.Orders);
    expect(inA?.id).toBe(inB?.id);
    expect(inA?.implied).toBe(false);
  });

  it("projects the model per view type", () => {
    const { ws, ids } = build();
    expect(suggestObjects(ws, "landscape", null).sort()).toEqual([ids.Shop, ids.Billing].sort());
    const inside = suggestObjects(ws, "container", ids.Shop);
    expect(inside).toEqual(expect.arrayContaining([ids.Web, ids.Orders, ids.OrdersDb, ids.Billing, ids.Cdn]));
    expect(inside).not.toContain(ids.Shop);
    expect(suggestObjects(ws, "dataflow", null)).toEqual(expect.arrayContaining([ids.OrdersDb, ids.Orders]));
    const context = suggestObjects(ws, "context", ids.Shop);
    expect(context).toEqual(expect.arrayContaining([ids.Shop, ids.Billing, ids.Cdn]));
  });

  it("keeps hand-placed nodes where they are when re-running auto-layout", () => {
    const { ws, ids } = build();
    const view = createView(ws, { name: "Inside", viewType: "container", scopeId: ids.Shop });
    const pinned = placeNodes(view.ws, view.diagram.id, { [ids.Web]: { x: 900, y: 700, pinned: true } });
    const after = relayout(pinned, view.diagram.id, true);
    expect(after.diagrams[view.diagram.id].nodes[ids.Web]).toEqual({ x: 900, y: 700, pinned: true });
    const reset = relayout(pinned, view.diagram.id, false);
    expect(reset.diagrams[view.diagram.id].nodes[ids.Web].pinned).toBe(false);
  });

  it("lays out without overlaps", () => {
    const ws = demoWorkspace();
    for (const d of Object.values(ws.diagrams)) {
      const placed = Object.values(d.nodes);
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const overlap = Math.abs(placed[i].x - placed[j].x) < NODE_W && Math.abs(placed[i].y - placed[j].y) < NODE_H;
          expect(overlap, `${d.name}: nodes ${i} and ${j} overlap`).toBe(false);
        }
      }
    }
    expect(autoLayout({ nodeIds: [], edges: [], direction: "TB" })).toEqual({});
  });

  it("zooms into an object by opening one detail diagram, not a new one each time", () => {
    const { ws, ids } = build();
    const first = ensureDetailDiagram(ws, ids.Shop);
    expect(first.created).toBe(true);
    const second = ensureDetailDiagram(first.ws, ids.Shop);
    expect(second.created).toBe(false);
    expect(second.diagramId).toBe(first.diagramId);
  });
});

describe("dependency and impact analysis (FR-15, FR-16)", () => {
  it("finds what an object depends on and what depends on it", () => {
    const { ws, ids } = build();
    const upstream = traverse(ws, ids.Web, "upstream").map((r) => r.id);
    expect(upstream).toEqual([ids.Orders, ids.OrdersDb]);
    const downstream = traverse(ws, ids.OrdersDb, "downstream");
    expect(downstream.map((r) => r.id).sort()).toEqual([ids.Orders, ids.Web, ids.Invoices].sort());
    expect(downstream.find((r) => r.id === ids.Web)?.distance).toBe(2);
  });

  it("ignores relationship kinds that are not dependencies", () => {
    const { ws, ids } = build();
    // The CDN routes to Web; it does not depend on it.
    expect(traverse(ws, ids.Web, "downstream").map((r) => r.id)).not.toContain(ids.Cdn);
  });

  it("counts nested objects as part of a system", () => {
    const { ws, ids } = build();
    const dependents = traverse(ws, ids.Shop, "downstream").map((r) => r.id);
    expect(dependents).toEqual([ids.Invoices]);
    expect(traverse(ws, ids.Shop, "downstream", { includeChildren: false })).toHaveLength(0);
  });

  it("reports affected objects, owners to tell, and diagrams to update", () => {
    const { ws, ids } = build();
    const view = createView(ws, { name: "Landscape", viewType: "landscape" });
    const report = impactOf(view.ws, ids.OrdersDb, "retiring")!;
    expect(report.affected.map((a) => a.object.name)).toEqual(["Orders", "Invoices", "Web"]);
    expect(report.owners).toEqual([
      { owner: "Digital", count: 2 },
      { owner: "Finance", count: 1 },
    ]);
    expect(report.affected.find((a) => a.object.name === "Invoices")?.path).toEqual(["OrdersDb", "Orders", "Invoices"]);
    expect(report.brokenRelationships).toHaveLength(1);
    expect(impactOf(view.ws, ids.OrdersDb, "changing")!.brokenRelationships).toHaveLength(0);
    expect(impactOf(view.ws, "missing", "changing")).toBeNull();
  });
});

describe("search and tags (FR-05)", () => {
  it("matches names first and supports tag, type and owner filters", () => {
    const ws = demoWorkspace();
    expect(searchObjects(ws, "order")[0].name).toMatch(/^Order/);
    expect(searchObjects(ws, "tag:pci").map((o) => o.name).sort()).toEqual(["Payment provider", "Payment service"]);
    expect(searchObjects(ws, "type:database owner:data").map((o) => o.name)).toEqual(["Data warehouse"]);
    expect(searchObjects(ws, "lifecycle:deprecated").map((o) => o.name)).toEqual(["Session cache"]);
    expect(searchObjects(ws, "kafka").map((o) => o.name)).toEqual(["Event bus"]); // matched through technology
    expect(searchDiagrams(ws, "landscape").map((d) => d.name)).toEqual(["System landscape"]);
    expect(searchObjects(ws, "zzzz")).toHaveLength(0);
  });
});
