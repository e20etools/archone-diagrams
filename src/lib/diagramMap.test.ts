import { describe, expect, it } from "vitest";
import { diagramMap, linkLabel, linksAmong, mapLayout, mapMermaid, mapPath, mapReach, mapRows } from "./diagramMap";
import { archiveDiagram, createDiagram, createObject, createRelationship, diagramBox, emptyWorkspace, setProtocols } from "./model";
import type { RelationKind, Workspace } from "./types";
import { addObjectsToDiagram } from "./views";

/** Identity (Directory, Directory DB) ← Sales (Portal, Orders) ← Reports (Reporting); Sales and Warehouse share Orders DB. */
function model() {
  let ws: Workspace = emptyWorkspace("Sara");
  const make = (typeId: string, name: string) => {
    const r = createObject(ws, { typeId, name });
    ws = r.ws;
    return r.object.id;
  };
  const link = (s: string, t: string, kind: RelationKind = "calls") => {
    const r = createRelationship(ws, { sourceId: s, targetId: t, kind });
    ws = r.ws;
    return r.relationship!.id;
  };
  const diagram = (name: string, ids: string[]) => {
    const r = createDiagram(ws, { name, viewType: "container" });
    ws = addObjectsToDiagram(r.ws, r.diagram.id, ids);
    return r.diagram.id;
  };
  const directory = make("service", "Directory");
  const dirDb = make("database", "Directory DB");
  const portal = make("webapp", "Portal");
  const orders = make("service", "Orders");
  const ordersDb = make("database", "Orders DB");
  const reporting = make("service", "Reporting");
  const loader = make("service", "Loader");
  link(directory, dirDb, "reads_writes");
  const toDirectory = link(portal, directory);
  ws = setProtocols(ws, toDirectory, [{ name: "LDAPS", port: "636" }]);
  link(portal, orders);
  link(orders, ordersDb, "reads_writes");
  link(reporting, orders);
  link(loader, ordersDb, "reads_writes");
  const identity = diagram("Identity", [directory, dirDb]);
  const sales = diagram("Sales", [portal, orders, ordersDb]);
  const reports = diagram("Reports", [reporting]);
  const warehouse = diagram("Warehouse", [loader, ordersDb]);
  const lonely = diagram("Lonely", [make("service", "Alone")]);
  return {
    ws,
    identity,
    sales,
    reports,
    warehouse,
    lonely,
    directory,
    portal,
    orders,
    ordersDb,
  };
}

describe("the map of all diagrams", () => {
  it("links diagrams by dependencies across them and by components they share", () => {
    const m = model();
    const map = diagramMap(m.ws);
    expect(map.nodes).toHaveLength(5);
    const dep = (a: string, b: string) => map.links.find((l) => l.kind === "depends" && l.from === a && l.to === b);
    expect(dep(m.sales, m.identity)?.reasons).toHaveLength(1);
    expect(dep(m.sales, m.identity)?.protocols).toEqual(["LDAPS"]);
    expect(dep(m.reports, m.sales)).toBeDefined();
    // Orders DB is on both Sales and Warehouse: they share it, and neither depends on the other for it.
    expect(map.links.find((l) => l.kind === "shared")?.shared).toEqual([m.ordersDb]);
    expect(dep(m.warehouse, m.sales)).toBeUndefined();
    expect(dep(m.sales, m.warehouse)).toBeUndefined();
    // Nothing within one diagram makes a link.
    expect(map.links.some((l) => l.from === l.to)).toBe(false);
    expect(map.nodes.find((n) => n.diagram.id === m.sales)?.linked).toEqual(expect.arrayContaining([m.portal, m.orders, m.ordersDb]));
    expect(linkLabel(m.ws, dep(m.sales, m.identity)!)).toBe("1 link · LDAPS");
  });

  it("counts a box that stands for another diagram as depending on it", () => {
    let { ws, sales, identity, reports } = model();
    const box = diagramBox(ws, identity);
    ws = addObjectsToDiagram(box.ws, reports, [box.objectId!]);
    const link = diagramMap(ws).links.find((l) => l.from === reports && l.to === identity);
    expect(link?.reasons[0].kind).toBe("shown as a box");
    expect(sales).toBeTruthy();
  });

  it("follows dependencies up to the level asked, both ways", () => {
    const m = model();
    const map = diagramMap(m.ws);
    const impacted = mapReach(map, m.identity, "neededBy");
    expect(impacted.get(m.sales)).toBe(1);
    expect(impacted.get(m.reports)).toBe(2);
    expect(mapReach(map, m.identity, "neededBy", 1).has(m.reports)).toBe(false);
    expect([...mapReach(map, m.reports, "needs").entries()]).toEqual([
      [m.sales, 1],
      [m.identity, 2],
    ]);
  });

  it("finds how picked diagrams connect, directly or through others", () => {
    const m = model();
    const map = diagramMap(m.ws);
    expect(linksAmong(map, [m.sales, m.identity])).toHaveLength(1);
    const path = mapPath(map, m.reports, m.warehouse);
    expect(path.map((l) => l.kind)).toEqual(["depends", "shared"]);
    expect(mapPath(map, m.lonely, m.sales)).toEqual([]);
  });

  it("leaves archived diagrams off the map", () => {
    let { ws, warehouse } = model();
    ws = archiveDiagram(ws, warehouse, "Sara", "Old");
    const map = diagramMap(ws);
    expect(map.nodes.some((n) => n.diagram.id === warehouse)).toBe(false);
    expect(map.links.some((l) => l.from === warehouse || l.to === warehouse)).toBe(false);
  });

  it("lays the map out and exports it as rows and as Mermaid", () => {
    const m = model();
    const map = diagramMap(m.ws);
    const at = mapLayout(map);
    expect(Object.keys(at)).toHaveLength(5);
    // What needs sits to the left of what it needs.
    expect(at[m.reports].x).toBeLessThan(at[m.sales].x);
    expect(at[m.sales].x).toBeLessThan(at[m.identity].x);
    const rows = mapRows(m.ws, map);
    expect(rows[0]).toEqual(["From diagram", "To diagram", "Kind", "Count", "Through", "Protocols"]);
    expect(rows.some((r) => r[0] === "Sales" && r[1] === "Identity" && r[4] === "Portal calls Directory" && r[5] === "LDAPS")).toBe(true);
    const mermaid = mapMermaid(m.ws, map);
    expect(mermaid.startsWith("flowchart LR")).toBe(true);
    expect(mermaid).toContain('-.-|"1 shared"|');
  });
});
