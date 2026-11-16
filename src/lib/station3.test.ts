import { describe, expect, it } from "vitest";
import { runChecks } from "./checks/checks";
import { fromRow, toRow } from "./cloud/rows";
import { TRUTH_FIELDS, checkCopy, confirmTruth, reviewIntervalDays, staleObjects, truthOf } from "./freshness";
import { confirmDependency, handshakeCounts, handshakeState, namesOf, needsHandshake, ownsTarget, pendingHandshakes, withdrawConfirmation } from "./handshake";
import { createObject, createRelationship, emptyWorkspace, placeNodes, updateObject, updateRelationship } from "./model";
import { AVAILABILITY_FIELD, declaredAvailability, downtimeHours, formatDowntime, resilienceOf, simulateFailure, singlePoints } from "./resilience";
import type { Workspace } from "./types";
import { createView } from "./views";

const DAY = 86_400_000;

function model() {
  let ws: Workspace = emptyWorkspace("T");
  const ids: Record<string, string> = {};
  const add = (key: string, name: string, typeId: string, owner = "", extra: Record<string, unknown> = {}) => {
    const made = createObject(ws, { name, typeId, owner, ...extra });
    ws = made.ws;
    ids[key] = made.object.id;
  };
  const rel: Record<string, string> = {};
  const link = (source: string, target: string, kind: "calls" | "reads_writes" | "routes_to" | "hosted_on" = "calls") => {
    const made = createRelationship(ws, { sourceId: ids[source], targetId: ids[target], kind });
    ws = made.ws;
    rel[`${source}>${target}`] = made.relationship!.id;
  };
  add("customer", "Customer", "actor");
  add("web", "Web shop", "web-app", "Digital");
  add("orders", "Orders", "service", "Digital", { tags: ["tier-1"] });
  add("db", "Orders DB", "database", "Digital");
  add("pay", "Payments", "service", "Payments team", { tags: ["tier-1"] });
  add("psp", "Card provider", "external-system", "Vendor desk");
  add("wiki", "Wiki", "application", "IT");
  add("gw", "Gateway", "gateway", "Platform");
  link("customer", "web");
  link("web", "orders");
  link("orders", "db", "reads_writes");
  link("orders", "pay");
  link("pay", "psp");
  link("gw", "orders", "routes_to");
  return { get ws() { return ws; }, set ws(next: Workspace) { ws = next; }, ids, rel };
}

describe("truth decay", () => {
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const aged = (days: number, extra: Record<string, unknown> = {}) => ({ ...createObject(emptyWorkspace("T"), { name: "X", typeId: "service", ...extra }).object, createdAt: new Date(now - days * DAY).toISOString() });

  it("counts from the day an object was added until someone confirms it", () => {
    expect(truthOf(aged(10), now)).toMatchObject({ confirmed: false, ageDays: 10, intervalDays: 180, state: "fresh", confidence: 0.96 });
    expect(truthOf(aged(90), now).state).toBe("aging");
    expect(truthOf(aged(180), now)).toMatchObject({ state: "stale", confidence: 0.5 });
    expect(truthOf(aged(360), now).confidence).toBe(0.25);
  });

  it("looks at what the business leans on hardest twice as often", () => {
    expect(reviewIntervalDays({ tags: ["tier-1"] })).toBe(90);
    expect(truthOf(aged(100, { tags: ["tier-1"] }), now).state).toBe("stale");
    expect(truthOf(aged(100), now).state).toBe("aging");
  });

  it("starts again when someone confirms the facts, and records who", () => {
    const m = model();
    const old = new Date(Date.now() - 400 * DAY).toISOString();
    m.ws = { ...m.ws, objects: Object.fromEntries(Object.values(m.ws.objects).map((o) => [o.id, { ...o, createdAt: old, lifecycle: o.id === m.ids.wiki ? ("retired" as const) : o.lifecycle }])) };
    // Retired things no longer change, so they are not asked about.
    expect(staleObjects(m.ws).map((o) => o.name).sort()).toEqual(["Card provider", "Customer", "Gateway", "Orders", "Orders DB", "Payments", "Web shop"]);
    const findings = runChecks(m.ws, null, ["practice"]).filter((f) => f.ruleId === "truth-stale");
    expect(findings).toHaveLength(7);
    expect(findings.find((f) => f.objectIds[0] === m.ids.orders)?.message).toMatch(/^Orders was added 400 days ago and nobody has confirmed it since\. It is due every 90 days\.$/);
    m.ws = confirmTruth(m.ws, m.ids.orders, " Olivia ");
    expect(m.ws.objects[m.ids.orders].fields[TRUTH_FIELDS.by]).toBe("Olivia");
    expect(truthOf(m.ws.objects[m.ids.orders])).toMatchObject({ confirmed: true, by: "Olivia", ageDays: 0, state: "fresh" });
    expect(staleObjects(m.ws)).toHaveLength(6);
    const later = Date.now() + 100 * DAY;
    expect(truthOf(m.ws.objects[m.ids.orders], later).state).toBe("stale");
  });
});

describe("a copy of a diagram against the model", () => {
  it("is current until something on it changes", async () => {
    const m = model();
    const view = createView(m.ws, { name: "Shop", viewType: "custom" });
    m.ws = placeNodes(view.ws, view.diagram.id, { [m.ids.web]: { x: 0, y: 0, pinned: true }, [m.ids.orders]: { x: 300, y: 0, pinned: true } });
    await new Promise((r) => setTimeout(r, 5));
    const printed = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const diagram = () => m.ws.diagrams[view.diagram.id];
    expect(checkCopy(m.ws, diagram(), printed)).toMatchObject({ valid: true, current: true, objects: [], relationships: 0, diagramEdited: false });
    // Something that is not on the diagram changes nothing for the copy.
    m.ws = updateObject(m.ws, m.ids.wiki, { technology: "Confluence" });
    expect(checkCopy(m.ws, diagram(), printed).current).toBe(true);
    m.ws = updateObject(m.ws, m.ids.orders, { technology: "Go" });
    m.ws = updateRelationship(m.ws, m.rel["web>orders"], { protocol: "HTTPS" });
    expect(checkCopy(m.ws, diagram(), printed)).toMatchObject({ current: false, objects: ["Orders"], relationships: 1, diagramEdited: false });
    m.ws = placeNodes(m.ws, view.diagram.id, { [m.ids.db]: { x: 0, y: 200, pinned: true } });
    expect(checkCopy(m.ws, diagram(), printed).diagramEdited).toBe(true);
    expect(checkCopy(m.ws, diagram(), "not a date")).toMatchObject({ valid: false, current: false });
  });
});

describe("the dependency handshake", () => {
  it("is asked only for a dependency between two different named owners", () => {
    const m = model();
    const r = (key: string) => m.ws.relationships[m.rel[key]];
    expect(needsHandshake(m.ws, r("orders>pay"))).toBe(true);
    expect(needsHandshake(m.ws, r("pay>psp"))).toBe(true);
    expect(needsHandshake(m.ws, r("web>orders"))).toBe(false); // same owner
    expect(needsHandshake(m.ws, r("customer>web"))).toBe(false); // the customer has no owner
    expect(needsHandshake(m.ws, r("gw>orders"))).toBe(false); // routing is not a dependency
    expect(handshakeState(m.ws, r("web>orders"))).toBe("none");
    expect(handshakeCounts(m.ws)).toEqual({ needed: 2, confirmed: 0 });
    expect(pendingHandshakes(m.ws).map((x) => x.id)).toEqual([m.rel["pay>psp"], m.rel["orders>pay"]]);
  });

  it("waits for the owner of the side that is depended on", () => {
    const m = model();
    const mine = namesOf({ name: "Pat", email: "payments-team@example.com" }, "Payments team");
    expect(mine).toEqual(["Payments team", "Pat", "payments-team@example.com", "payments-team"]);
    expect(pendingHandshakes(m.ws, mine).map((x) => x.id)).toEqual([m.rel["orders>pay"]]);
    expect(ownsTarget(m.ws, m.ws.relationships[m.rel["pay>psp"]], mine)).toBe(false);
    expect(pendingHandshakes(m.ws, namesOf({ email: "digital@example.com" }))).toEqual([]);
  });

  it("is recorded with who and when, and taken back when the relationship changes", () => {
    const m = model();
    const id = m.rel["orders>pay"];
    const before = m.ws.relationships[id].updatedAt;
    m.ws = confirmDependency(m.ws, id, "Pat", "2026-03-01T00:00:00.000Z");
    expect(m.ws.relationships[id].acknowledgement).toEqual({ by: "Pat", at: "2026-03-01T00:00:00.000Z" });
    expect(m.ws.relationships[id].updatedAt).toBe(before);
    expect(handshakeState(m.ws, m.ws.relationships[id])).toBe("confirmed");
    expect(handshakeCounts(m.ws)).toEqual({ needed: 2, confirmed: 1 });
    expect(runChecks(m.ws, null, ["practice"]).filter((f) => f.ruleId === "dependency-unconfirmed").map((f) => f.message)).toEqual(["Payments (Payments team) depends on Card provider, and Vendor desk has not confirmed it."]);
    // Saying the same thing again changes nothing; saying something new does.
    expect(updateRelationship(m.ws, id, { kind: "calls" }).relationships[id].acknowledgement).toBeDefined();
    expect(updateRelationship(m.ws, id, { protocol: "HTTPS" }).relationships[id].acknowledgement).toBeUndefined();
    expect("acknowledgement" in withdrawConfirmation(m.ws, id).relationships[id]).toBe(false);
    // A relationship that needs no handshake cannot be confirmed.
    expect(confirmDependency(m.ws, m.rel["web>orders"], "Pat")).toBe(m.ws);
  });

  it("travels to the database and back, and is cleared there when taken back", () => {
    const m = model();
    const id = m.rel["orders>pay"];
    expect(toRow("relationships", "ws", id, m.ws.relationships[id]).acknowledged).toBeNull();
    const confirmed = confirmDependency(m.ws, id, "Pat", "2026-03-01T00:00:00.000Z").relationships[id];
    const row = toRow("relationships", "ws", id, confirmed);
    expect(row.acknowledged).toEqual({ by: "Pat", at: "2026-03-01T00:00:00.000Z" });
    expect(fromRow("relationships", JSON.parse(JSON.stringify(row))).value).toEqual(confirmed);
    expect(fromRow("relationships", { ...row, acknowledged: null }).value).toEqual(m.ws.relationships[id]);
    // A stored version from before the column existed has no such key.
    const { acknowledged: _none, ...older } = row;
    expect(fromRow("relationships", older).value).toEqual(m.ws.relationships[id]);
  });
});

describe("failure and resilience", () => {
  it("lists everything that stops when something stops, nearest first, with the way it gets there", () => {
    const m = model();
    const report = simulateFailure(m.ws, [m.ids.psp]);
    expect(report.failed.map((o) => o.name)).toEqual(["Card provider"]);
    expect(report.affected.map((c) => [c.object.name, c.distance])).toEqual([["Payments", 1], ["Orders", 2], ["Web shop", 3], ["Customer", 4]]);
    expect(report.affected[2].path).toEqual(["Card provider", "Payments", "Orders", "Web shop"]);
    expect(report.tier1).toEqual(["Orders", "Payments"]);
    expect(report.people).toEqual(["Customer"]);
    expect(report.owners).toEqual([{ owner: "Digital", count: 2 }, { owner: "", count: 1 }, { owner: "Payments team", count: 1 }]);
    // Routing is not a dependency, so the gateway keeps running.
    expect(report.affected.some((c) => c.object.name === "Gateway")).toBe(false);
  });

  it("takes the shortest way when several things stop at once, and does not list what was switched off", () => {
    const m = model();
    const report = simulateFailure(m.ws, [m.ids.psp, m.ids.db, "missing"]);
    expect(report.failed.map((o) => o.name)).toEqual(["Card provider", "Orders DB"]);
    expect(report.affected.find((c) => c.object.name === "Orders")).toMatchObject({ distance: 1, path: ["Orders DB", "Orders"] });
    expect(simulateFailure(m.ws, [m.ids.wiki]).affected).toEqual([]);
    expect(simulateFailure(m.ws, [m.ids.orders, m.ids.pay]).affected.map((c) => c.object.name)).toEqual(["Web shop", "Customer"]);
  });

  it("reads an availability however it is typed", () => {
    const o = (value: string) => ({ fields: { [AVAILABILITY_FIELD]: value } });
    expect([declaredAvailability(o("99.9")), declaredAvailability(o(" 99,95 % ")), declaredAvailability(o("100"))]).toEqual([99.9, 99.95, 100]);
    expect([declaredAvailability(o("")), declaredAvailability(o("high")), declaredAvailability(o("0")), declaredAvailability(o("101"))]).toEqual([null, null, null, null]);
    expect(downtimeHours(99.9)).toBe(8.8);
    expect([formatDowntime(0), formatDowntime(0.5), formatDowntime(8.8), formatDowntime(100)]).toEqual(["none", "30 minutes a year", "8.8 hours a year", "4 days a year"]);
  });

  it("multiplies an object's availability with that of everything it depends on, each once", () => {
    const m = model();
    const set = (key: string, value: string) => (m.ws = updateObject(m.ws, m.ids[key], { fields: { [AVAILABILITY_FIELD]: value } }));
    set("orders", "99.9");
    set("pay", "99.9");
    set("psp", "99.5");
    const orders = resilienceOf(m.ws, m.ids.orders)!;
    expect(orders).toMatchObject({ declared: 99.9, dependsOn: 3, undeclared: 1 });
    expect(orders.effective).toBeCloseTo(99.9 * 0.999 * 0.995, 3);
    expect(orders.weakest).toMatchObject({ availability: 99.5 });
    expect(orders.weakest?.object.name).toBe("Card provider");
    expect(orders.downtimeHours).toBeCloseTo(61.2, 0);
    const web = resilienceOf(m.ws, m.ids.web)!;
    expect(web.declared).toBeNull();
    expect(web.effective).toBe(orders.effective);
    expect(resilienceOf(m.ws, m.ids.wiki)).toMatchObject({ effective: 100, dependsOn: 0, undeclared: 1, weakest: null, downtimeHours: 0 });
    expect(resilienceOf(m.ws, "missing")).toBeNull();
  });

  it("ranks the objects whose failure takes the most with it", () => {
    const m = model();
    const points = singlePoints(m.ws);
    expect(points.map((p) => [p.object.name, p.dependents, p.tier1, p.people])).toEqual([
      ["Card provider", 3, 2, 1],
      ["Payments", 2, 1, 1],
      ["Orders", 1, 0, 1],
      ["Orders DB", 2, 1, 1],
      ["Web shop", 0, 0, 1],
    ].sort((a, b) => (b[1] as number) - (a[1] as number) || (b[2] as number) - (a[2] as number) || (b[3] as number) - (a[3] as number) || String(a[0]).localeCompare(String(b[0]))));
    expect(singlePoints(m.ws, 2)).toHaveLength(2);
  });
});
