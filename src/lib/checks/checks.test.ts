import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { createObject, createRelationship, emptyWorkspace, findByName, updateObject } from "../model";
import type { Workspace } from "../types";
import { DATA_FIELDS, PACKS, RULES, agentLens, agentReach, withAgentField, dataLens, dataMap, dataMapCsv, findingsCsv, isDataField, runChecks, withDataField } from "./checks";

function build() {
  let ws: Workspace = emptyWorkspace();
  const add = (name: string, typeId: string, extra: Partial<Parameters<typeof createObject>[1]> = {}) => {
    const made = createObject(ws, { name, typeId, owner: "Team", description: "x", ...extra });
    ws = made.ws;
    return made.object.id;
  };
  const link = (sourceId: string, targetId: string, protocol = "HTTPS") => {
    ws = createRelationship(ws, { sourceId, targetId, kind: "calls", protocol }).ws;
  };
  const set = (id: string, fields: Record<string, string>) => {
    ws = updateObject(ws, id, { fields });
  };
  return { add, link, set, get ws() { return ws; } };
}
const ids = (ws: Workspace, packs: Parameters<typeof runChecks>[2]) => runChecks(ws, null, packs).map((f) => f.ruleId);

describe("the data lens", () => {
  it("reads and writes its three fields among the object's own fields", () => {
    const b = build();
    const id = b.add("CRM", "database", { fields: { "Cost centre": "42" } });
    let o = b.ws.objects[id];
    expect(dataLens(o)).toEqual({ classification: "", personal: "", residency: "" });
    o = { ...o, fields: withDataField(o, "classification", "Confidential") };
    o = { ...o, fields: withDataField(o, "personal", "yes") };
    o = { ...o, fields: withDataField(o, "residency", " EU ") };
    expect(o.fields).toEqual({ "Cost centre": "42", [DATA_FIELDS.classification]: "Confidential", [DATA_FIELDS.personal]: "Yes", [DATA_FIELDS.residency]: "EU" });
    expect(dataLens(o)).toEqual({ classification: "Confidential", personal: "yes", residency: "EU" });
    expect(withDataField(o, "residency", "")).not.toHaveProperty(DATA_FIELDS.residency);
    expect(isDataField("Personal data") && !isDataField("Cost centre")).toBe(true);
  });
  it("accepts values typed or imported loosely", () => {
    const b = build();
    const id = b.add("CRM", "database", { fields: { "Data classification": "restricted", "Personal data": "TRUE" } });
    expect(dataLens(b.ws.objects[id])).toMatchObject({ classification: "Restricted", personal: "yes" });
  });
});

describe("checks", () => {
  it("every rule belongs to a pack that exists, and ids are unique", () => {
    const packIds = PACKS.map((p) => p.id) as string[];
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const rule of RULES) expect(rule.packs.length > 0 && rule.packs.every((p) => packIds.includes(p)), rule.id).toBe(true);
  });
  it("a tidy model has no findings in any pack", () => {
    const b = build();
    const app = b.add("Shop", "service");
    const db = b.add("Shop DB", "database", { fields: { "Data classification": "Internal", "Personal data": "No" } });
    b.link(app, db, "TLS");
    expect(runChecks(b.ws, null, PACKS.map((p) => p.id))).toEqual([]);
  });
  it("finds missing owners and descriptions, unconnected objects and old dependencies", () => {
    const b = build();
    const app = b.add("Shop", "service", { owner: "", description: "" });
    const old = b.add("Mainframe", "server", { lifecycle: "retired" });
    const fading = b.add("Old cache", "cache", { lifecycle: "deprecated", fields: { "Data classification": "Internal", "Personal data": "No" } });
    b.add("Lonely", "application");
    b.add("A customer", "actor", { owner: "" });
    b.link(app, old);
    b.link(app, fading, "TLS");
    const found = runChecks(b.ws, null, ["practice"]);
    expect(found.map((f) => f.ruleId)).toEqual(["retired-in-use", "deprecated-in-use", "owner-missing", "description-missing", "unconnected", "unconnected"]);
    expect(found[0]).toMatchObject({ severity: "high", message: "Shop relies on Mainframe, which is retired.", objectIds: [app, old] });
    // People and outside systems are not expected to have an owner here.
    expect(found.filter((f) => f.ruleId === "owner-missing")).toHaveLength(1);
  });
  it("finds unencrypted connections, exposed stores and unclassified data", () => {
    const b = build();
    const app = b.add("Shop", "service");
    const db = b.add("Shop DB", "database");
    const partner = b.add("Partner", "external-system");
    b.link(app, db, "http");
    b.link(partner, db, "");
    expect(ids(b.ws, ["security"])).toEqual(["clear-text", "store-exposed", "classification-missing", "protocol-missing"]);
    expect(runChecks(b.ws, null, ["security"])[0].message).toBe("Shop to Shop DB uses HTTP, which is not encrypted.");
  });
  it("follows personal data: ownership, where it is kept, and where it goes", () => {
    const b = build();
    const crm = b.add("CRM", "database", { owner: "", fields: { "Data classification": "Confidential", "Personal data": "Yes" } });
    const lake = b.add("Data lake", "storage", { fields: { "Data classification": "Confidential", "Personal data": "Yes", "Data residency": "US" } });
    const eu = b.add("Billing", "service", { fields: { "Data residency": "EU" } });
    const mail = b.add("Mail provider", "external-system");
    b.link(eu, lake);
    b.link(crm, mail);
    b.link(eu, crm);
    expect(ids(b.ws, ["privacy"])).toEqual(["personal-unowned", "personal-crosses-border", "personal-residency", "personal-to-outside"]);
  });
  it("marks what touches card data and leaves alone what is separated by a gateway", () => {
    const b = build();
    const pay = b.add("Payments", "service", { tags: ["pci"] });
    const vault = b.add("Card vault", "database", { tags: ["pci"], fields: { "Data classification": "Confidential", "Personal data": "No" } });
    const shop = b.add("Shop", "service");
    const edge = b.add("Edge", "gateway");
    b.link(pay, vault, "TLS");
    b.link(shop, pay);
    b.link(edge, pay);
    const found = runChecks(b.ws, null, ["pci"]);
    expect(found.map((f) => f.ruleId)).toEqual(["pci-classified", "pci-scope"]);
    expect(found[1].message).toBe("Shop is connected to Payments, which is tagged pci, but is not tagged pci itself.");
  });
  it("checks only what a diagram shows when given one", () => {
    const ws = demoWorkspace();
    const whole = runChecks(ws, null, ["practice", "security"]);
    const diagram = Object.values(ws.diagrams)[0];
    const part = runChecks(ws, diagram, ["practice", "security"]);
    expect(whole.length).toBeGreaterThan(part.length);
    const shown = new Set(Object.keys(diagram.nodes));
    expect(part.every((f) => f.objectIds.some((id) => shown.has(id)))).toBe(true);
    expect(whole.some((f) => f.ruleId === "deprecated-in-use" && f.objectIds.includes(findByName(ws, "Session cache")!.id))).toBe(true);
  });
  it("exports findings and the data map", () => {
    const b = build();
    const crm = b.add("CRM", "database", { owner: "Sales, EMEA", fields: { "Personal data": "Yes", "Data residency": "EU" } });
    const app = b.add("Portal", "web-app", { fields: { "Data residency": "US" } });
    b.link(app, crm, "http");
    const csv = findingsCsv(b.ws, runChecks(b.ws, null, ["security"]));
    expect(csv.split("\r\n")[1]).toBe('high,Connections are encrypted,"Portal to CRM uses HTTP, which is not encrypted.",Portal; CRM,"Team; Sales, EMEA"');
    const map = dataMap(b.ws);
    expect(map.rows.map((r) => r.object.name)).toEqual(["CRM", "Portal"]);
    expect(map.flows).toHaveLength(1);
    expect(map.flows[0].notes).toEqual(["US to EU", "not encrypted"]);
    expect(dataMapCsv(b.ws).split("\r\n")[1]).toBe('CRM,Database,,"Sales, EMEA",,yes,EU');
  });
});

describe("AI agents", () => {
  const agentIds = (ws: Workspace) => runChecks(ws, null, ["ai"]).map((f) => f.ruleId);
  it("finds an agent that reads untrusted content, reaches private data and can send outside", () => {
    const b = build();
    const agent = b.add("Support assistant", "ai-agent");
    const model = b.add("Hosted model", "ai-model");
    const tools = b.add("CRM tools", "mcp-server");
    const crm = b.add("CRM", "database", { fields: { "Data classification": "Confidential", "Personal data": "Yes" } });
    const mail = b.add("Mail provider", "external-system");
    b.link(agent, model);
    b.link(agent, tools);
    b.link(tools, crm);
    expect(agentIds(b.ws)).toEqual(["agent-undeclared"]);
    // The private data is reached through the MCP server; the mail provider is both the stranger's way in and the way out.
    b.link(agent, mail);
    const found = runChecks(b.ws, null, ["ai"]);
    expect(found.map((f) => f.ruleId)).toEqual(["agent-trifecta", "agent-undeclared"]);
    expect(found[0]).toMatchObject({ severity: "high" });
    expect(found[0].message).toBe("Support assistant has all three: it reads from Mail provider; it can reach CRM; and it can reach Mail provider. Remove one of the three, or put a person's approval before anything is sent.");
    expect(found[0].objectIds.sort()).toEqual([agent, crm, mail].sort());
    expect(found[0].relationshipIds).toHaveLength(4);
    expect(runChecks(b.ws, null, ["security"]).map((f) => f.ruleId)).toContain("agent-trifecta");
  });
  it("believes a person who says one of the three is not there, and one who says it is", () => {
    const b = build();
    const agent = b.add("Mailer", "ai-agent");
    const model = b.add("Model", "ai-model");
    const crm = b.add("CRM", "database", { fields: { "Data classification": "Restricted", "Personal data": "No" } });
    const mail = b.add("Mail provider", "external-system");
    b.link(agent, model);
    b.link(agent, crm);
    b.link(agent, mail);
    expect(agentIds(b.ws)).toContain("agent-trifecta");
    b.set(agent, withAgentField(b.ws.objects[agent], "outward", "no"));
    b.set(agent, withAgentField(b.ws.objects[agent], "untrusted", "yes"));
    expect(agentIds(b.ws)).toEqual([]);
    b.set(agent, withAgentField(b.ws.objects[agent], "outward", "yes"));
    expect(runChecks(b.ws, null, ["ai"])[0].message).toContain("it is marked as reading untrusted content; it can reach CRM; and it is marked as able to send outside");
    expect(agentLens(b.ws.objects[agent])).toEqual({ untrusted: "yes", outward: "yes" });
    expect(isDataField("Reads untrusted content") && isDataField("Can send outside")).toBe(true);
    expect(withAgentField(b.ws.objects[agent], "outward", "")).not.toHaveProperty("Can send outside");
  });
  it("counts input that a person or an outside system sends to the agent, and ignores what is not private", () => {
    const b = build();
    const agent = b.add("Triage bot", "ai-agent", { fields: { "Can send outside": "Yes" } });
    const model = b.add("Model", "ai-model");
    const customer = b.add("Customer", "actor");
    const docs = b.add("Public docs", "storage", { fields: { "Data classification": "Public", "Personal data": "No" } });
    b.link(agent, model);
    b.link(customer, agent);
    b.link(agent, docs);
    expect(agentIds(b.ws)).toEqual(["agent-undeclared"]);
    b.set(docs, { "Data classification": "Internal", "Personal data": "Yes" });
    const found = runChecks(b.ws, null, ["ai"]);
    expect(found[0].message).toContain("it takes input from Customer; it can reach Public docs; and it is marked as able to send outside");
  });
  it("does not follow what the agent's data stores themselves connect to, and asks for the model", () => {
    const b = build();
    const agent = b.add("Reporter", "ai-agent", { fields: { "Reads untrusted content": "Yes", "Can send outside": "Yes" } });
    const app = b.add("Reports", "service");
    const vault = b.add("Vault", "database", { fields: { "Data classification": "Restricted", "Personal data": "No" } });
    b.link(agent, app);
    b.link(app, vault);
    expect(agentIds(b.ws)).toEqual(["agent-model"]);
    expect(agentReach(b.ws, b.ws.objects[agent], Object.values(b.ws.relationships)).touched.map((o) => o.name)).toEqual(["Reports"]);
  });
});
