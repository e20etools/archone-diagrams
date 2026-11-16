import { describe, expect, it } from "vitest";
import { parseTranscript, transcriptToProposal } from "./ai/transcript";
import { CALM_SCHEMA, toCalm } from "./calm";
import { PACKS, RULES, rulesOf, runChecks } from "./checks/checks";
import { demoWorkspace } from "./demo";
import { mayConnect } from "./mcp/mayConnect";
import { createObject, createRelationship, emptyWorkspace, updateObject } from "./model";
import { AVAILABILITY_FIELD } from "./resilience";
import type { Workspace } from "./types";

function build() {
  let ws: Workspace = emptyWorkspace("Shop");
  const ids: Record<string, string> = {};
  const add = (key: string, name: string, typeId: string, extra: Record<string, unknown> = {}) => {
    const made = createObject(ws, { name, typeId, ...extra });
    ws = made.ws;
    ids[key] = made.object.id;
  };
  const link = (source: string, target: string, kind: Parameters<typeof createRelationship>[1]["kind"] = "calls", protocol = "") => {
    const made = createRelationship(ws, { sourceId: ids[source], targetId: ids[target], kind, protocol });
    ws = made.ws;
    return made.relationship!.id;
  };
  return { get ws() { return ws; }, set ws(next: Workspace) { ws = next; }, ids, add, link };
}

describe("FINOS CALM export", () => {
  const m = build();
  m.add("store", "Online store", "system", { owner: "Digital" });
  m.add("customer", "Customer", "actor");
  m.add("web", "Web shop", "web-app", { parentId: undefined });
  m.add("orders", "Orders", "service", { description: "Takes orders", technology: "Go", tags: ["tier-1"] });
  m.add("db", "Orders DB", "database");
  m.add("k8s", "Cluster", "cluster");
  m.add("psp", "Card provider", "external-system");
  m.ws = updateObject(m.ws, m.ids.web, { parentId: m.ids.store });
  m.ws = updateObject(m.ws, m.ids.orders, { parentId: m.ids.store });
  const uses = m.link("customer", "web");
  const calls = m.link("web", "orders", "calls", "https");
  m.link("orders", "db", "reads_writes", "TCP/5432");
  m.link("orders", "k8s", "hosted_on");
  m.link("orders", "psp", "calls", "HTTPS");
  const doc = toCalm(m.ws, null, "2026-11-16T00:00:00.000Z");

  it("writes every object as a node with the fields CALM requires", () => {
    expect(doc.$schema).toBe(CALM_SCHEMA);
    expect(doc.nodes).toHaveLength(7);
    for (const node of doc.nodes) {
      expect(node["unique-id"]).toBeTruthy();
      expect(node.name).toBeTruthy();
      expect(node.description).toBeTruthy();
      expect(["actor", "ecosystem", "system", "service", "database", "network", "ldap", "webclient", "data-asset"]).toContain(node["node-type"]);
    }
    const by = (name: string) => doc.nodes.find((n) => n.name === name)!;
    expect(by("Customer")["node-type"]).toBe("actor");
    expect(by("Web shop")["node-type"]).toBe("webclient");
    expect(by("Orders")).toMatchObject({ "node-type": "service", description: "Takes orders", metadata: { "archone-type": "service", technology: "Go", tags: ["tier-1"], lifecycle: "active" } });
    expect(by("Orders DB").description).toBe("Database");
    expect(by("Card provider").metadata).toMatchObject({ external: true });
    expect(by("Online store").metadata).toMatchObject({ owner: "Digital" });
  });

  it("writes containment, hosting, people and connections as the four kinds of relationship", () => {
    const kind = (r: (typeof doc.relationships)[number]) => Object.keys(r["relationship-type"])[0];
    expect(doc.relationships.map(kind).sort()).toEqual(["composed-of", "connects", "connects", "connects", "deployed-in", "interacts"]);
    const of = (k: string) => doc.relationships.filter((r) => kind(r) === k);
    expect(of("composed-of")[0]["relationship-type"]).toEqual({ "composed-of": { container: m.ids.store, nodes: [m.ids.web, m.ids.orders].sort() } });
    expect(of("deployed-in")[0]["relationship-type"]).toEqual({ "deployed-in": { container: m.ids.k8s, nodes: [m.ids.orders] } });
    expect(of("interacts")[0]).toMatchObject({ "unique-id": uses, "relationship-type": { interacts: { actor: m.ids.customer, nodes: [m.ids.web] } } });
    const call = doc.relationships.find((r) => r["unique-id"] === calls)!;
    expect(call).toMatchObject({ protocol: "HTTPS", description: "Web shop calls Orders", "relationship-type": { connects: { source: { node: m.ids.web }, destination: { node: m.ids.orders } } } });
    // A protocol CALM does not list is left out instead of written wrongly.
    expect(doc.relationships.find((r) => r.description === "Orders reads / writes Orders DB")?.protocol).toBeUndefined();
    const ids = doc.relationships.map((r) => r["unique-id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exports one diagram with only what is on it", () => {
    const demo = demoWorkspace();
    const diagram = Object.values(demo.diagrams).find((d) => d.name === "System landscape")!;
    const one = toCalm(demo, diagram);
    expect(one.nodes.map((n) => n["unique-id"]).sort()).toEqual(Object.keys(diagram.nodes).sort());
    const known = new Set(one.nodes.map((n) => n["unique-id"]));
    for (const r of one.relationships) {
      const type = r["relationship-type"] as Record<string, any>;
      const ends = type.connects ? [type.connects.source.node, type.connects.destination.node] : type.interacts ? [type.interacts.actor, ...type.interacts.nodes] : [(type["composed-of"] ?? type["deployed-in"]).container, ...(type["composed-of"] ?? type["deployed-in"]).nodes];
      for (const end of ends) expect(known.has(end)).toBe(true);
    }
    expect(one.metadata[0]).toMatchObject({ diagram: "System landscape" });
  });
});

describe("the NCA ECC pack", () => {
  it("is a pack of its own, names the subdomain in every rule of its own, and says it is not compliance", () => {
    const pack = PACKS.find((p) => p.id === "nca")!;
    expect(pack.about).toMatch(/ECC-2:2024/);
    expect(pack.about).toMatch(/not compliance/);
    const own = RULES.filter((r) => r.id.startsWith("nca-"));
    expect(own.map((r) => r.id)).toEqual(["nca-third-party", "nca-third-party-data", "nca-hosting", "nca-backup", "nca-resilience"]);
    for (const rule of own) expect(rule.why).toMatch(/^ECC (2-7|2-9|3-1|4-1|4-2), /);
    expect(rulesOf(["nca"]).map((r) => r.id).sort()).toEqual([...own.map((r) => r.id), "clear-text", "protocol-missing", "store-exposed", "classification-missing", "sensitive-on-old"].sort());
    expect(RULES).toHaveLength(27);
  });

  it("finds outside parties nobody answers for, classified data leaving, unknown hosting, missing copies and tier-1 without a figure", () => {
    const m = build();
    m.add("crm", "CRM", "service", { owner: "Sales", tags: ["tier-1"], fields: { "Data classification": "Confidential" } });
    m.add("db", "Customer DB", "database", { owner: "Sales", fields: { "Data classification": "Restricted" } });
    m.add("mail", "Mail provider", "external-system");
    m.add("unused", "Unused vendor", "external-system");
    m.link("crm", "db", "reads_writes", "TLS");
    const out = m.link("crm", "mail", "calls");
    const findings = runChecks(m.ws, null, ["nca"]);
    const of = (rule: string) => findings.filter((f) => f.ruleId === rule).map((f) => f.message);
    expect(of("nca-third-party")).toEqual(["Mail provider is an outside system connected to yours, with no owner and no description."]);
    expect(of("nca-third-party-data")).toEqual(["CRM holds confidential data and connects to Mail provider, an outside system, with no protocol recorded."]);
    expect(findings.find((f) => f.ruleId === "nca-third-party-data")?.relationshipIds).toEqual([out]);
    expect(of("nca-hosting")).toEqual(["Customer DB holds restricted data and does not say where it is hosted."]);
    expect(of("nca-backup")).toEqual(["Customer DB shows no copy: nothing it replicates to, and no Backup field."]);
    expect(of("nca-resilience")).toEqual(["CRM is tier-1 and has no availability written down."]);

    m.add("replica", "Customer DB replica", "database", { owner: "Sales" });
    m.link("db", "replica", "replicates_to");
    m.ws = updateObject(m.ws, m.ids.db, { fields: { "Data classification": "Restricted", "Data residency": "Saudi Arabia" } });
    m.ws = updateObject(m.ws, m.ids.crm, { fields: { "Data classification": "Confidential", [AVAILABILITY_FIELD]: "99.9" } });
    m.ws = updateObject(m.ws, m.ids.mail, { owner: "IT", description: "Hosted mail, run by a vendor" });
    const after = runChecks(m.ws, null, ["nca"]).map((f) => f.ruleId);
    for (const rule of ["nca-third-party", "nca-hosting", "nca-backup", "nca-resilience"]) expect(after).not.toContain(rule);
    expect(after).toContain("nca-third-party-data");
  });
});

describe("may this connect to that", () => {
  const m = build();
  m.add("web", "Web shop", "web-app", { owner: "Digital" });
  m.add("orders", "Orders", "service", { owner: "Digital", fields: { "Data classification": "Confidential" } });
  m.add("db", "Orders DB", "database", { owner: "Digital" });
  m.add("old", "Legacy billing", "service", { owner: "Finance", lifecycle: "retired" });
  m.add("aging", "Session cache", "cache", { owner: "Platform", lifecycle: "deprecated" });
  m.add("pay", "Payments", "service", { owner: "Payments team" });
  m.add("partner", "Partner portal", "external-system");
  m.add("twin", "Orders", "service");
  m.link("web", "orders", "calls", "HTTPS");
  m.link("orders", "aging", "reads_writes");
  // The model as the API returns it.
  const model = { objects: Object.values(m.ws.objects), relationships: Object.values(m.ws.relationships) };
  const ask = (source: string, target: string, protocol?: string) => mayConnect(model, { source, target, protocol });

  it("says yes to what the model already has", () => {
    const v = ask("Web shop", m.ids.orders);
    expect(v).toMatchObject({ answer: "yes", existing: { kind: "calls", protocol: "HTTPS" } });
    expect(v.summary).toBe("Yes. The model has Web shop calls Orders over HTTPS.");
    // An existing dependency on something deprecated is allowed to stay, with a warning.
    const kept = ask(m.ids.orders, "session cache");
    expect(kept.answer).toBe("yes");
    expect(kept.reasons).toEqual([{ rule: "deprecated-in-use", says: "Session cache is deprecated, so no new dependency on it should be added.", blocks: false }]);
  });

  it("says no when a rule forbids it, and names the rule", () => {
    expect(ask("Web shop", "Legacy billing")).toMatchObject({ answer: "no", reasons: [{ rule: "retired-in-use", blocks: true }, { rule: "dependency-unconfirmed", blocks: false }] });
    expect(ask("Web shop", "Session cache").reasons[0]).toMatchObject({ rule: "deprecated-in-use", blocks: true });
    expect(ask("Partner portal", "Orders DB")).toMatchObject({ answer: "no", reasons: [{ rule: "store-exposed" }] });
    expect(ask("Web shop", "Payments", "http").summary).toMatch(/^No\. HTTP is not encrypted/);
    expect(ask(m.ids.orders, "Partner portal")).toMatchObject({ answer: "no", reasons: [{ rule: "data-to-outside", blocks: true }] });
    // The protocol asked about also counts against a relationship that exists.
    expect(ask("Web shop", m.ids.orders, "HTTP").answer).toBe("no");
  });

  it("says unknown when the model does not have it, and what to do next", () => {
    const v = ask("Web shop", "Payments", "HTTPS");
    expect(v).toMatchObject({ answer: "unknown", existing: null });
    expect(v.summary).toMatch(/^Not known\. Nothing in the model forbids Web shop connecting to Payments/);
    expect(v.reasons).toEqual([{ rule: "dependency-unconfirmed", says: "Payments belongs to Payments team, who would have to confirm a new dependency from Digital.", blocks: false }]);
    expect(v.next).toMatch(/propose_changes/);
    expect(ask("Web shop", "Nothing here").summary).toBe('The model has no object called "Nothing here", so it cannot say anything about the target.');
    expect(ask("Web shop", "Orders").summary).toMatch(/^2 objects are called "Orders"\. Ask again with the id/);
    expect(ask("Web shop", "web shop").summary).toBe("Source and target are the same object.");
    expect(mayConnect(null, { source: "a", target: "b" }).answer).toBe("unknown");
  });
});

describe("from a meeting to a proposal", () => {
  const text = `[00:01] Olivia: Welcome everyone. Let's talk about the partner launch.
[00:02] Sam (Architect): The partner portal will call the billing service over HTTPS. The billing service stores invoices in the ledger database.
and it also publishes events to Kafka.
00:03 Olivia: Fine by me.
Priya: The mobile app calls the billing service too.`;

  it("splits a transcript into who said what", () => {
    const turns = parseTranscript(text);
    expect(turns.map((t) => t.speaker)).toEqual(["Olivia", "Sam", "Olivia", "Priya"]);
    expect(turns[1].text).toMatch(/ledger database\. and it also publishes events to Kafka\.$/);
    expect(parseTranscript("No speakers here.\nJust notes.")).toEqual([{ speaker: "", text: "No speakers here. Just notes." }]);
    expect(parseTranscript("See https://example.com: it is all there")[0].speaker).toBe("");
  });

  it("turns each sentence that connects things into suggestions that carry the sentence and its speaker", () => {
    let ws = emptyWorkspace("T");
    const existing = createObject(ws, { name: "Billing service", typeId: "service" });
    ws = existing.ws;
    const proposal = transcriptToProposal(ws, text);
    expect(proposal).toMatchObject({ origin: "ai-prompt", sourceKind: "transcript", status: "pending", source: "Meeting transcript: 4 turns, 3 speakers" });
    const names = proposal.objects.map((o) => o.name.toLowerCase());
    expect(names).toEqual(expect.arrayContaining(["partner portal", "billing service", "ledger database", "mobile app"]));
    // The billing service is named three times and proposed once, matched to the one in the model.
    expect(names.filter((n) => n === "billing service")).toHaveLength(1);
    const billing = proposal.objects.find((o) => o.name.toLowerCase() === "billing service")!;
    expect(billing.matchId).toBe(existing.object.id);
    expect(billing.evidence).toBe('Sam: "The partner portal will call the billing service over HTTPS."');
    const name = (key: string) => proposal.objects.find((o) => o.key === key)!.name.toLowerCase();
    const said = proposal.relationships.map((r) => `${name(r.sourceKey)} > ${name(r.targetKey)} | ${r.evidence}`);
    expect(said).toContain('partner portal > billing service | Sam: "The partner portal will call the billing service over HTTPS."');
    expect(said).toContain('mobile app > billing service | Priya: "The mobile app calls the billing service too."');
    expect(said.some((s) => s.startsWith("billing service > ledger database | Sam:"))).toBe(true);
    // Small talk proposes nothing.
    expect(proposal.objects.every((o) => !/welcome|launch/i.test(o.name))).toBe(true);
    expect(proposal.notes).toMatch(/does not understand a decision/);
    expect(transcriptToProposal(ws, "Olivia: Hello there, how are you all today?").objects).toEqual([]);
  });
});
