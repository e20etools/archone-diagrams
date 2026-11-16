import { describe, expect, it } from "vitest";
import { createObject, createRelationship, emptyWorkspace, updateObject } from "../model";
import type { RuleCheck, Selector, Workspace } from "../types";
import { ruleById, rulesRun, runChecks } from "./checks";
import { createRule, deleteRule, describeRule, emptySelector, runCustomCheck, updateRule } from "./custom";
import { parseRule } from "./parseRule";

const sel = (part: Partial<Selector> = {}): Selector => ({ ...emptySelector(), ...part });

function model() {
  let ws = emptyWorkspace("Shop");
  const ids: Record<string, string> = {};
  const add = (key: string, name: string, typeId: string, more: Record<string, unknown> = {}) => {
    const made = createObject(ws, { name, typeId, ...more });
    ws = made.ws;
    ids[key] = made.object.id;
  };
  const link = (a: string, b: string, protocol = "") => (ws = createRelationship(ws, { sourceId: ids[a], targetId: ids[b], kind: "calls", protocol }).ws);
  add("customer", "Customer", "actor");
  add("web", "Web shop", "web-app", { owner: "Digital" });
  add("gateway", "API gateway", "gateway", { owner: "Platform" });
  add("orders", "Orders service", "service", { owner: "Digital", tags: ["pci"] });
  add("legacy", "Legacy batch", "service", { lifecycle: "deprecated" });
  add("db", "Orders database", "database", { tags: ["pci"] });
  add("psp", "Payment provider", "external-system");
  add("mail", "Mailer", "external-system");
  ws = updateObject(ws, ids.db, { fields: { "Personal data": "Yes", "Data classification": "Restricted" } });
  link("customer", "web", "HTTPS");
  link("web", "gateway", "HTTPS");
  link("gateway", "orders", "HTTPS");
  link("orders", "db", "TCP");
  link("orders", "psp", "HTTPS");
  link("legacy", "db", "TCP");
  link("web", "legacy", "HTTP");
  link("legacy", "mail", "HTTP");
  return { ws, ids };
}
const run = (ws: Workspace, check: RuleCheck) => runCustomCheck(ws, check, Object.values(ws.objects), Object.values(ws.relationships)).map((f) => f.message);

describe("rules a workspace writes for itself", () => {
  const { ws, ids } = model();

  it("checks what every chosen object has to have", () => {
    expect(run(ws, { kind: "object", subject: sel({ types: ["service", "database"] }), require: "owner", value: "" })).toEqual(["Legacy batch has no owner.", "Orders database has no owner."]);
    expect(run(ws, { kind: "object", subject: sel({ tags: ["pci"] }), require: "classification", value: "" })).toEqual(["Orders service has no data classification."]);
    expect(run(ws, { kind: "object", subject: sel({ types: ["service"] }), require: "lifecycle", value: "active, planned" })).toEqual(["Legacy batch is deprecated."]);
    expect(run(ws, { kind: "object", subject: sel({ personal: true }), require: "tag", value: "pci" })).toEqual([]);
    expect(run(ws, { kind: "object", subject: sel({ types: ["database"] }), require: "field", value: "Data classification = Internal" })).toEqual(['Orders database has "Data classification" set to "Restricted", not "Internal".']);
    expect(run(ws, { kind: "object", subject: sel({ name: "orders" }), require: "no-tag", value: "pci" })).toHaveLength(2);
  });

  it("checks how two sets of objects may connect", () => {
    expect(run(ws, { kind: "connection", from: sel({ lifecycle: ["deprecated"] }), to: sel({ types: ["database"] }), mode: "never", value: "" })).toEqual(["Legacy batch and Orders database are connected."]);
    expect(run(ws, { kind: "connection", from: sel({ types: ["web-app"] }), to: sel({ types: ["gateway", "actor"] }), mode: "only", value: "" })).toEqual(["Web shop is connected to Legacy batch."]);
    expect(run(ws, { kind: "connection", from: sel(), to: sel({ types: ["external-system"] }), mode: "protocol", value: "HTTPS, mTLS" })).toEqual(["Legacy batch to Mailer uses HTTP."]);
  });

  it("tests a journey: what may or must lie on the way", () => {
    const always: RuleCheck = { kind: "journey", from: sel({ types: ["actor"] }), to: sel({ types: ["database"] }), through: sel({ types: ["gateway"] }), mode: "always" };
    expect(run(ws, always)).toEqual(["Customer reaches Orders database without passing through it: Customer, then Web shop, then Legacy batch, then Orders database."]);
    const never: RuleCheck = { kind: "journey", from: sel({ types: ["actor"] }), to: sel({ personal: true }), through: sel({ lifecycle: ["deprecated"] }), mode: "never" };
    const found = runCustomCheck(ws, never, Object.values(ws.objects), Object.values(ws.relationships));
    expect(found.map((f) => f.message)).toEqual(["Customer reaches Orders database through Legacy batch: Customer, then Web shop, then Legacy batch, then Orders database."]);
    expect(found[0].objectIds).toEqual([ids.customer, ids.web, ids.legacy, ids.db]);
    expect(found[0].relationshipIds).toHaveLength(3);
    // Take the shortcut away and both journeys pass.
    const fixed = { ...ws, relationships: Object.fromEntries(Object.entries(ws.relationships).filter(([, r]) => !(r.sourceId === ids.web && r.targetId === ids.legacy))) };
    expect(run(fixed, always)).toEqual([]);
    expect(run(fixed, never)).toEqual([]);
  });

  it("says each rule as a sentence", () => {
    expect(describeRule(ws, { kind: "object", subject: sel({ types: ["database"], tags: ["pci"], personal: true }), require: "owner", value: "" })).toBe("All databases tagged pci that hold personal data must have an owner.");
    expect(describeRule(ws, { kind: "connection", from: sel({ types: ["external-system"] }), to: sel({ types: ["database", "storage"] }), mode: "never", value: "" })).toBe("No connection between external systems and databases or file storage.");
    expect(describeRule(ws, { kind: "journey", from: sel({ types: ["actor"] }), to: sel({ types: ["database"] }), through: sel({ types: ["gateway"] }), mode: "always" })).toBe("Every way from people to databases passes through gateways.");
    expect(describeRule(ws, { kind: "connection", from: sel(), to: sel({ inside: ids.web }), mode: "protocol", value: "https" })).toBe("Connections between objects and objects inside Web shop use https.");
  });

  it("runs with the built-in checks, each rule with its own switch", () => {
    const before = runChecks(ws, null, ["practice"]).length;
    const made = createRule(ws, { title: "", text: "Deprecated things stay away from databases", severity: "high", check: { kind: "connection", from: sel({ lifecycle: ["deprecated"] }), to: sel({ types: ["database"] }), mode: "never", value: "" } });
    expect(made.rule.title).toBe("No connection between deprecated objects and databases.");
    const findings = runChecks(made.ws, null, ["practice"]);
    expect(findings.length).toBe(before + 1);
    expect(findings[0]).toMatchObject({ ruleId: made.rule.id, severity: "high" });
    expect(ruleById(made.rule.id, made.ws)?.title).toBe(made.rule.title);
    expect(ruleById(made.rule.id)).toBeUndefined();
    expect(rulesRun(["practice"], made.ws) - rulesRun(["practice"], ws)).toBe(1);
    // With no pack ticked the workspace's own rules still run; switched off, they do not.
    expect(runChecks(made.ws, null, [])).toHaveLength(1);
    const off = updateRule(made.ws, made.rule.id, { enabled: false });
    expect(runChecks(off, null, [])).toHaveLength(0);
    expect(rulesRun([], off)).toBe(0);
    expect(deleteRule(off, made.rule.id).rules).toEqual({});
  });
});

describe("reading a rule from a sentence", () => {
  const { ws, ids } = model();
  const read = (text: string) => {
    const parsed = parseRule(ws, text);
    return parsed ? describeRule(ws, parsed.check) : null;
  };

  it("reads what objects must have", () => {
    expect(read("Every database must have an owner")).toBe("All databases must have an owner.");
    expect(read("All services tagged pci should have a description.")).toBe("All services tagged pci must have a description.");
    expect(read("Anything that holds personal data must say where its data is kept")).toBe("All objects that hold personal data must say where their data is kept.");
    expect(read("External systems must be tagged reviewed")).toBe("All external systems must be tagged reviewed.");
    expect(read("Databases must not be deprecated")).toBe("All databases must be planned, active or retired.");
    expect(parseRule(ws, "Every database must have an owner")?.severity).toBe("high");
    expect(parseRule(ws, "Services should have a description")?.severity).toBe("medium");
  });

  it("reads how things may connect", () => {
    expect(read("External systems must never connect directly to databases")).toBe("No connection between external systems and databases.");
    expect(read("Deprecated services cannot call the Orders database")).toBe('No connection between deprecated services and objects named "Orders database".');
    expect(read("Web apps may only connect to gateways")).toBe("Web apps connect only to gateways.");
    expect(read("Connections from services to external systems must use HTTPS or mTLS")).toBe("Connections between services and external systems use https or mtls.");
  });

  it("reads a journey test", () => {
    expect(read("Traffic from customers to databases must pass through a gateway")).toBe("Every way from people to databases passes through gateways.");
    expect(read("Users must not reach personal data through deprecated services")).toBe("Nothing on the way from people to objects that hold personal data passes through deprecated services.");
    expect(read("Customers must not reach databases without passing through the API gateway")).toBe('Every way from people to databases passes through objects named "API gateway".');
    const check = parseRule(ws, "Nothing inside Web shop may reach external systems via Legacy batch")?.check;
    expect(check).toMatchObject({ kind: "journey", mode: "never", from: { inside: ids.web }, through: { name: "Legacy batch" } });
  });

  it("reads the same rules written in Arabic", () => {
    expect(read("يجب أن يكون لكل قاعدة بيانات مالك")).toBe("All databases must have an owner.");
    expect(read("لا يجوز أن تتصل الأنظمة الخارجية بقواعد البيانات")).toBe("No connection between external systems and databases.");
    expect(read("يجب أن يمر الاتصال من العملاء إلى قواعد البيانات عبر بوابة")).toBe("Every way from people to databases passes through gateways.");
  });

  it("says what it could not read, and gives up on a sentence that is not a rule", () => {
    expect(parseRule(ws, "Databases in the blue zone must have an owner")?.unread.join(" ")).toMatch(/blue zone/);
    expect(parseRule(ws, "Every database must have an owner")?.unread).toEqual([]);
    expect(parseRule(ws, "We like tidy diagrams")).toBeNull();
    expect(parseRule(ws, "")).toBeNull();
  });
});
