import { describe, expect, it } from "vitest";
import { componentTree, flatten, levelCounts, treeDiagrams } from "./componentTree";
import { createDiagram, createObject, createRelationship, emptyWorkspace, setProtocols, updateRelationship } from "./model";
import type { RelationKind, Workspace } from "./types";
import { addObjectsToDiagram } from "./views";

/**
 * A chain six deep from the Portal: Portal → API → Orders → Orders DB → Storage → Disk → Rack,
 * a Mobile app and a Partner that call the Portal, the API replicating to a backup (not a
 * dependency), a second route from the Portal to Orders, and two diagrams.
 */
function model() {
  let ws: Workspace = emptyWorkspace("Sara");
  const make = (typeId: string, name: string) => {
    const r = createObject(ws, { typeId, name });
    ws = r.ws;
    return r.object.id;
  };
  const link = (sourceId: string, targetId: string, kind: RelationKind = "calls") => {
    const r = createRelationship(ws, { sourceId, targetId, kind });
    ws = r.ws;
    return r.relationship!.id;
  };
  const portal = make("webapp", "Portal");
  const api = make("service", "API");
  const orders = make("service", "Orders");
  const db = make("database", "Orders DB");
  const storage = make("service", "Storage");
  const disk = make("service", "Disk");
  const rack = make("service", "Rack");
  const mobile = make("mobile-app", "Mobile app");
  const partner = make("service", "Partner");
  const backup = make("service", "Backup");
  const toApi = link(portal, api);
  ws = setProtocols(ws, toApi, [{ name: "HTTPS", port: "443", transport: "TCP" }]);
  link(api, orders);
  link(orders, db, "reads_writes");
  link(db, storage, "hosted_on");
  link(storage, disk, "hosted_on");
  link(disk, rack, "hosted_on");
  link(portal, orders, "depends_on");
  link(mobile, portal);
  const fromPartner = link(partner, portal);
  ws = updateRelationship(ws, fromPartner, { flow: "both" });
  link(api, backup, "replicates_to");
  const shop = createDiagram(ws, { name: "Shop", viewType: "container" });
  ws = addObjectsToDiagram(shop.ws, shop.diagram.id, [portal, api, mobile]);
  const data = createDiagram(ws, { name: "Data", viewType: "dataflow" });
  ws = addObjectsToDiagram(data.ws, data.diagram.id, [db, storage]);
  return { ws, portal, api, orders, db, storage, disk, rack, mobile, partner, backup, shop: shop.diagram.id, data: data.diagram.id };
}

const names = (ws: Workspace, ids: string[]) => ids.map((id) => ws.objects[id].name);

describe("the relationship tree of a component", () => {
  it("follows what the component relies on to the fifth level, each object once at its nearest level", () => {
    const m = model();
    const tree = componentTree(m.ws, m.portal, "out");
    const all = flatten(tree);
    const placed = all.filter((n) => !n.repeat);
    expect(names(m.ws, placed.filter((n) => n.level === 1).map((n) => n.id)).sort()).toEqual(["API", "Orders", "Partner"]);
    // Orders is reached directly, so it is not placed again under the API; the second way there is a reference.
    const viaApi = tree.find((n) => n.id === m.api)!;
    expect(viaApi.children.find((c) => c.id === m.orders)).toMatchObject({ repeat: true, children: [] });
    expect(viaApi.link.protocols).toEqual(["HTTPS"]);
    // Portal → Orders → Orders DB → Storage → Disk → Rack is five steps; nothing goes deeper.
    expect(placed.find((n) => n.id === m.rack)?.level).toBe(5);
    expect(Math.max(...all.map((n) => n.level))).toBe(5);
    expect(levelCounts(tree)).toEqual([3, 2, 1, 1, 1]);
  });

  it("stops at the chosen level", () => {
    const m = model();
    const tree = componentTree(m.ws, m.portal, "out", 2);
    expect(Math.max(...flatten(tree).map((n) => n.level))).toBe(2);
    expect(levelCounts(tree).slice(2)).toEqual([0, 0, 0]);
  });

  it("lists what relies on the component against the arrows, and a two-way link on both sides once", () => {
    const m = model();
    const into = componentTree(m.ws, m.portal, "in");
    expect(names(m.ws, into.map((n) => n.id)).sort()).toEqual(["Mobile app", "Partner"]);
    const partner = into.find((n) => n.id === m.partner)!;
    expect(partner.link.both).toBe(true);
    // The way back to the Portal over the same relationship is not a branch.
    expect(partner.children).toEqual([]);
  });

  it("keeps or drops relationships that are not dependencies", () => {
    const m = model();
    const all = flatten(componentTree(m.ws, m.api, "out", 5, "all")).map((n) => n.id);
    const dependencies = flatten(componentTree(m.ws, m.api, "out", 5, "dependencies")).map((n) => n.id);
    expect(all).toContain(m.backup);
    expect(dependencies).not.toContain(m.backup);
  });

  it("names the diagrams the component and its relations are on, nearest first", () => {
    const m = model();
    const trees = { out: componentTree(m.ws, m.portal, "out"), in: componentTree(m.ws, m.portal, "in") };
    const reached = treeDiagrams(m.ws, m.portal, trees);
    expect(reached.map((r) => [r.diagram.name, r.level, r.objects.length])).toEqual([
      ["Shop", 0, 3],
      ["Data", 2, 2],
    ]);
    expect(reached[0].sides.sort()).toEqual(["in", "out"]);
    expect(reached[1].sides).toEqual(["out"]);
  });

  it("answers nothing for an object that is not in the model", () => {
    expect(componentTree(model().ws, "obj_missing", "out")).toEqual([]);
  });
});
