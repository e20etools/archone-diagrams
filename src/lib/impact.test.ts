import { describe, expect, it } from "vitest";
import { analyse, diagramsReached, pathOf, riskOf, walk, whatIf } from "./impact";
import { createDiagram, createObject, createRelationship, diagramBox, emptyWorkspace, setProtocols, updateObject } from "./model";
import type { RelationKind, Workspace } from "./types";
import { addObjectsToDiagram } from "./views";

/**
 * Two diagrams. Identity: Directory needs its database; Portal (in the second diagram) uses the
 * Identity diagram box. Sales: People use the Portal, the Portal calls Orders, Orders reads Orders DB.
 */
function model() {
  let ws: Workspace = emptyWorkspace("Sara");
  const make = (typeId: string, name: string, extra: Record<string, unknown> = {}) => {
    const r = createObject(ws, { typeId, name, ...extra });
    ws = r.ws;
    return r.object.id;
  };
  const link = (sourceId: string, targetId: string, kind: RelationKind = "calls") => {
    const r = createRelationship(ws, { sourceId, targetId, kind });
    ws = r.ws;
    return r.relationship!.id;
  };
  const directory = make("service", "Directory", {
    componentId: "integrations.active-directory",
  });
  const dirDb = make("database", "Directory DB");
  const portal = make("webapp", "Portal");
  const orders = make("service", "Orders");
  const ordersDb = make("database", "Orders DB");
  const people = make("actor", "Sales people");
  const audit = make("service", "Audit");
  link(directory, dirDb, "reads_writes");
  const id1 = createDiagram(ws, { name: "Identity", viewType: "container" });
  ws = addObjectsToDiagram(id1.ws, id1.diagram.id, [directory, dirDb]);
  const box = diagramBox(ws, id1.diagram.id);
  ws = box.ws;
  const toBox = link(portal, box.objectId!, "depends_on");
  ws = setProtocols(ws, toBox, [{ name: "LDAPS", port: "636", transport: "TCP" }]);
  link(people, portal, "calls");
  link(portal, orders);
  link(orders, ordersDb, "reads_writes");
  link(audit, orders);
  const sales = createDiagram(ws, { name: "Sales", viewType: "container" });
  ws = addObjectsToDiagram(sales.ws, sales.diagram.id, [people, portal, orders, ordersDb, box.objectId!, audit]);
  return {
    ws,
    directory,
    dirDb,
    portal,
    orders,
    ordersDb,
    people,
    audit,
    box: box.objectId!,
    identity: id1.diagram.id,
    sales: sales.diagram.id,
  };
}

describe("impact and dependencies", () => {
  it("walks what something depends on, level by level", () => {
    const m = model();
    const steps = walk(m.ws, [m.people], "needs");
    const level = (id: string) => steps.find((s) => s.id === id)?.level;
    expect(level(m.portal)).toBe(1);
    expect(level(m.orders)).toBe(2);
    expect(level(m.box)).toBe(2);
    // Through the box into the other diagram.
    expect(level(m.directory)).toBe(3);
    expect(level(m.dirDb)).toBe(3);
    expect(steps.find((s) => s.id === m.box)?.protocols).toEqual(["LDAPS"]);
    expect(pathOf(m.ws, steps, m.directory)).toEqual(["Sales people", "Portal", "Identity", "Directory"]);
  });

  it("stops at the level asked for", () => {
    const m = model();
    expect(walk(m.ws, [m.people], "needs", 1).map((s) => s.id)).toEqual([m.portal]);
    expect(walk(m.ws, [m.people], "needs", 2).some((s) => s.id === m.directory)).toBe(false);
  });

  it("finds what is impacted, across diagrams, from a database inside another diagram", () => {
    const m = model();
    const result = analyse(m.ws, { kind: "object", id: m.dirDb });
    const level = (id: string) => result.impact.find((s) => s.id === id)?.level;
    expect(level(m.directory)).toBe(1);
    expect(level(m.box)).toBe(1);
    expect(level(m.portal)).toBe(2);
    expect(level(m.people)).toBe(3);
    expect(result.diagramsImpacted.map((d) => d.diagram.name)).toContain("Sales");
  });

  it("analyses a whole diagram and a library component", () => {
    const m = model();
    const identity = analyse(m.ws, { kind: "diagram", id: m.identity });
    expect(identity.start).toEqual(expect.arrayContaining([m.directory, m.dirDb, m.box]));
    expect(identity.impact.map((s) => s.id)).toEqual(expect.arrayContaining([m.portal, m.people]));
    // A diagram is not listed as impacting itself.
    expect(identity.diagramsImpacted.map((d) => d.diagram.id)).not.toContain(m.identity);
    const ad = analyse(m.ws, {
      kind: "component",
      id: "integrations.active-directory",
    });
    expect(ad.start).toEqual([m.directory]);
    expect(ad.impact.some((s) => s.id === m.portal)).toBe(true);
    // An object not linked to the library still counts when it is named as the component.
    expect(analyse(m.ws, { kind: "component", id: "integration.event-bus" }).start).toEqual([]);
    const bus = createObject(m.ws, { typeId: "queue", name: "Event bus" });
    expect(analyse(bus.ws, { kind: "component", id: "integration.event-bus" }).start).toEqual([bus.object.id]);
  });

  it("counts how much of each diagram is reached", () => {
    const m = model();
    const steps = walk(m.ws, [m.ordersDb], "neededBy");
    const sales = diagramsReached(m.ws, steps).find((d) => d.diagram.id === m.sales)!;
    expect(sales.count).toBe(4); // Orders, Portal, Audit, Sales people
    expect(sales.of).toBe(6);
    expect(sales.level).toBe(1);
  });

  it("rates what stops: severity, impact level and remedies", () => {
    const m = model();
    let ws = updateObject(m.ws, m.orders, { tags: ["tier-1"] });
    const result = whatIf(ws, [{ kind: "object", id: m.ordersDb }]);
    const severity = (id: string) => result.affected.find((a) => a.object.id === id)?.severity;
    expect(severity(m.orders)).toBe("critical");
    expect(severity(m.people)).toBe("high");
    expect(result.people).toEqual(["Sales people"]);
    expect(result.impact).toBe(5);
    expect(result.remedies.some((r) => /replica/i.test(r.text))).toBe(true);
    expect(result.remedies.some((r) => /disaster recovery/i.test(r.text))).toBe(true);
    ws = updateObject(ws, m.orders, { tags: [] });
    const calm = whatIf(ws, [{ kind: "object", id: m.audit }]);
    expect(calm.affected).toEqual([]);
    expect(calm.impact).toBe(1);
  });

  it("can stop several things at once, including a whole diagram", () => {
    const m = model();
    const result = whatIf(m.ws, [
      { kind: "diagram", id: m.identity },
      { kind: "object", id: m.orders },
    ]);
    expect(result.stopped.map((o) => o.name)).toEqual(expect.arrayContaining(["Directory", "Directory DB", "Orders"]));
    expect(result.affected.map((a) => a.object.name)).toEqual(expect.arrayContaining(["Portal", "Audit", "Sales people"]));
    expect(result.remedies.some((r) => /recovery runbook/i.test(r.text))).toBe(true);
  });

  it("scores risk on the five by five grid", () => {
    expect(riskOf(1, 1)).toEqual({ score: 1, level: "low" });
    expect(riskOf(2, 3).level).toBe("medium");
    expect(riskOf(3, 4).level).toBe("high");
    expect(riskOf(4, 5).level).toBe("critical");
  });
});
