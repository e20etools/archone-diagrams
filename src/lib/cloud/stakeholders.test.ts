import { describe, expect, it } from "vitest";
import { createObject, createRelationship, deleteObject, emptyWorkspace, updateObject } from "../model";
import { personFor, reachOf } from "./stakeholders";
import { toTables } from "./tables";

const people = [
  { userId: "u1", name: "Olivia", email: "olivia@example.com" },
  { userId: "u2", name: "", email: "payments@example.com" },
];

function model() {
  let ws = emptyWorkspace("T");
  const add = (name: string, owner: string, typeId = "service") => {
    const made = createObject(ws, { name, typeId, owner });
    ws = made.ws;
    return made.object.id;
  };
  const link = (sourceId: string, targetId: string) => (ws = createRelationship(ws, { sourceId, targetId, kind: "calls" }).ws);
  const ledger = add("Ledger", "Payments");
  const db = add("Ledger DB", "", "database");
  const checkout = add("Checkout", "Olivia");
  const web = add("Web shop", "Storefront");
  const far = add("Reports", "Finance");
  const unrelated = add("Wiki", "IT");
  link(ledger, db);
  link(checkout, ledger);
  link(web, checkout);
  link(far, web);
  return { ws, ledger, db, checkout, web, far, unrelated };
}

describe("who a change touches", () => {
  it("matches an owner to a member by name, email or the name before the @", () => {
    expect(personFor("olivia", people)?.userId).toBe("u1");
    expect(personFor(" Payments ", people)?.userId).toBe("u2");
    expect(personFor("payments@example.com", people)?.userId).toBe("u2");
    expect(personFor("Finance", people)).toBeUndefined();
    expect(personFor("", people)).toBeUndefined();
  });

  it("lists the owners of what changed first, then of what depends on it", () => {
    const m = model();
    const after = updateObject(m.ws, m.ledger, { technology: "Go" });
    const reach = reachOf(toTables(m.ws), toTables(after), people);
    expect(reach.stakeholders.map((s) => [s.owner, s.changed, s.affected, s.person?.userId])).toEqual([
      ["Payments", ["Ledger"], [], "u2"],
      ["Finance", [], ["Reports"], undefined],
      ["Olivia", [], ["Checkout"], "u1"],
      ["Storefront", [], ["Web shop"], undefined],
    ]);
    expect(reach.unowned).toEqual([]);
    expect(reachOf(toTables(m.ws), toTables(after), people, 1).stakeholders.map((s) => s.owner)).toEqual(["Payments", "Olivia"]);
  });

  it("counts both ends of a changed relationship, objects with no owner, and what depended on a removed object", () => {
    const m = model();
    const linked = createRelationship(m.ws, { sourceId: m.unrelated, targetId: m.db, kind: "reads_writes" }).ws;
    const one = reachOf(toTables(m.ws), toTables(linked), people);
    expect(one.unowned).toEqual(["Ledger DB"]);
    expect(one.stakeholders.find((s) => s.owner === "IT")?.changed).toEqual(["Wiki"]);
    expect(one.stakeholders.find((s) => s.owner === "Payments")?.affected).toEqual(["Ledger"]);

    const removed = reachOf(toTables(m.ws), toTables(deleteObject(m.ws, m.ledger)), people);
    expect(removed.stakeholders.find((s) => s.owner === "Payments")?.changed).toEqual(["Ledger"]);
    expect(removed.stakeholders.find((s) => s.owner === "Olivia")?.changed).toEqual(["Checkout"]);
    expect(removed.stakeholders.find((s) => s.owner === "Storefront")?.affected).toEqual(["Web shop"]);
  });

  it("treats everything as new when nothing was published before", () => {
    const m = model();
    const reach = reachOf(null, toTables(m.ws), people);
    expect(reach.stakeholders.map((s) => s.owner).sort()).toEqual(["Finance", "IT", "Olivia", "Payments", "Storefront"]);
    expect(reach.stakeholders.every((s) => s.affected.length === 0)).toBe(true);
    expect(reach.unowned).toEqual(["Ledger DB"]);
  });
});
