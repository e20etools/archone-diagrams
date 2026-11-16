import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { createObject, emptyWorkspace } from "../model";
import type { Proposal } from "../types";
import { visibleEdges } from "../views";
import { draftFromText } from "./heuristic";
import { applyProposal, draftToProposal, proposalCounts, saveProposal, setAllDecisions, updateProposal } from "./proposals";
import { normalizeDraft } from "./schema";
import { aiStatus, extractJson, handleAiRequest, resolveProvider } from "./server-core";

const names = (d: ReturnType<typeof draftFromText>) => d.objects.map((o) => o.name);
const edges = (d: ReturnType<typeof draftFromText>) => {
  const byKey = new Map(d.objects.map((o) => [o.key, o.name]));
  return d.relationships.map((r) => `${byKey.get(r.sourceKey)} -${r.kind}-> ${byKey.get(r.targetKey)}`);
};

describe("built-in drafting rules (AI-01 without a model)", () => {
  it("reads a typical description", () => {
    const d = draftFromText(
      "Customers use the web portal, which calls the API gateway. The gateway routes requests to the order service and the payment service. " +
        "The order service stores data in PostgreSQL and publishes events to Kafka. The payment service calls Stripe.",
    );
    expect(names(d)).toEqual(["Customer", "Web portal", "API gateway", "Order service", "Payment service", "PostgreSQL", "Kafka", "Stripe"]);
    expect(edges(d)).toEqual([
      "Customer -calls-> Web portal",
      "Web portal -calls-> API gateway",
      "API gateway -routes_to-> Order service",
      "API gateway -routes_to-> Payment service",
      "Order service -reads_writes-> PostgreSQL",
      "Order service -calls-> Kafka",
      "Payment service -calls-> Stripe",
    ]);
    const type = (n: string) => d.objects.find((o) => o.name === n)?.typeId;
    expect(type("Customer")).toBe("actor");
    expect(type("Web portal")).toBe("web-app");
    expect(type("API gateway")).toBe("gateway");
    expect(type("PostgreSQL")).toBe("database");
    expect(type("Kafka")).toBe("queue");
    expect(type("Stripe")).toBe("external-system");
  });

  it("reads arrow chains, including names it does not know", () => {
    const d = draftFromText("Browser -> Checkout API -> Orders DB\nCheckout API -> Fraud Checker");
    expect(names(d)).toEqual(["Browser", "Checkout API", "Orders DB", "Fraud Checker"]);
    expect(edges(d)).toEqual([
      "Browser -calls-> Checkout API",
      "Checkout API -reads_writes-> Orders DB",
      "Checkout API -calls-> Fraud Checker",
    ]);
  });

  it("attaches technologies instead of drawing them, and merges product names with their noun", () => {
    const d = draftFromText("A React frontend talks to a Node.js backend. The backend reads from a PostgreSQL database and uses a Redis cache.");
    expect(names(d)).toEqual(["Frontend", "Backend", "PostgreSQL", "Redis"]);
    expect(d.objects.find((o) => o.name === "Frontend")?.technology).toBe("React");
    expect(d.objects.find((o) => o.name === "Backend")?.technology).toBe("Node.js");
    expect(edges(d)).toEqual(["Frontend -calls-> Backend", "Backend -reads_writes-> PostgreSQL", "Backend -reads_writes-> Redis"]);
  });

  it("understands containment, hosting and passive voice", () => {
    const d = draftFromText(
      "The billing platform consists of an invoice service, a tax service and a billing database. " +
        "The invoice service is called by the customer portal. All services are deployed on Kubernetes.",
    );
    const platform = d.objects.find((o) => o.name === "Billing platform")!;
    expect(platform.typeId).toBe("system");
    expect(d.objects.filter((o) => o.parentKey === platform.key).map((o) => o.name)).toEqual(["Invoice service", "Tax service", "Billing database"]);
    expect(edges(d)).toContain("Customer portal -calls-> Invoice service");
    expect(edges(d)).toContain("Invoice service -hosted_on-> Kubernetes");
    expect(edges(d)).toContain("Tax service -hosted_on-> Kubernetes");
  });

  it("returns nothing rather than inventing components", () => {
    const d = draftFromText("Please make it fast and beautiful.");
    expect(d.objects).toHaveLength(0);
    expect(d.notes).toMatch(/found no components/);
  });
});

describe("draft validation", () => {
  it("merges duplicate names, repairs keys and drops relationships that point nowhere", () => {
    const d = normalizeDraft({
      objects: [
        { key: 1, name: "API", typeId: "service" },
        { key: 2, name: " api ", typeId: "service" },
        { key: 3, name: "DB", typeId: "not-a-type", parentKey: 3 },
        { key: 4, name: "   " },
      ],
      relationships: [
        { sourceKey: 2, targetKey: 3, kind: "Reads Writes" },
        { sourceKey: 1, targetKey: 3, kind: "reads_writes" },
        { sourceKey: 1, targetKey: 99, kind: "calls" },
        { sourceKey: 1, targetKey: 2, kind: "calls" },
      ],
      notes: null,
    })!;
    expect(d.objects.map((o) => o.name)).toEqual(["API", "DB"]);
    expect(d.objects[1].typeId).toBe("application");
    expect(d.objects[1].parentKey).toBeNull();
    expect(d.relationships).toEqual([{ sourceKey: "1", targetKey: "3", kind: "reads_writes", label: "" }]);
    expect(normalizeDraft("not a draft")).toBeNull();
    expect(normalizeDraft({ objects: "x" })).toBeNull();
  });
});

describe("AI endpoint (AI-01, AI-02)", () => {
  const draftJson = JSON.stringify({
    objects: [
      { key: "a", name: "Mobile app", typeId: "mobile-app" },
      { key: "b", name: "Core API", typeId: "service" },
    ],
    relationships: [{ sourceKey: "a", targetKey: "b", kind: "calls", label: "" }],
    notes: "",
  });

  it("answers 501 without a key so the browser can fall back", async () => {
    const r = await handleAiRequest({ mode: "prompt", text: "web app calls api" }, {});
    expect(r.status).toBe(501);
    expect(aiStatus({})).toEqual({ configured: false, engine: null });
  });

  it("rejects bad input before calling any provider", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    expect((await handleAiRequest({ mode: "prompt", text: "" }, { ANTHROPIC_API_KEY: "k" }, spy)).status).toBe(400);
    expect((await handleAiRequest({ mode: "image", image: { mime: "image/svg+xml", data: "x".repeat(200) } }, { ANTHROPIC_API_KEY: "k" }, spy)).status).toBe(400);
    expect(called).toBe(false);
  });

  it("calls Anthropic with the image and reads a fenced JSON answer", async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "```json\n" + draftJson + "\n```" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await handleAiRequest(
      { mode: "image", text: "hand sketch", image: { mime: "image/png", data: "A".repeat(200) } },
      { ANTHROPIC_API_KEY: "secret-key" },
      fake,
    );
    expect(r.status).toBe(200);
    expect((r.body.draft as any).objects).toHaveLength(2);
    expect(r.body.engine).toBe("anthropic:claude-sonnet-5-5");
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen!.headers["x-api-key"]).toBe("secret-key");
    expect(seen!.body.messages[0].content[0].type).toBe("image");
    expect(JSON.stringify(r.body)).not.toContain("secret-key");
  });

  it("calls an OpenAI-style provider and reports provider failures without leaking details", async () => {
    const ok = (async () => new Response(JSON.stringify({ choices: [{ message: { content: draftJson } }] }), { status: 200 })) as unknown as typeof fetch;
    const env = { AI_PROVIDER: "lovable", LOVABLE_API_KEY: "k", AI_MODEL: "some/model" };
    expect(resolveProvider(env)?.baseUrl).toBe("https://ai.gateway.lovable.dev/v1");
    expect((await handleAiRequest({ mode: "prompt", text: "mobile app calls core api" }, env, ok)).status).toBe(200);

    const failing = (async () => new Response("account 123 over quota", { status: 429 })) as unknown as typeof fetch;
    const bad = await handleAiRequest({ mode: "prompt", text: "mobile app calls core api" }, env, failing);
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.body)).not.toContain("account 123");

    const garbage = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "I cannot help" } }] }), { status: 200 })) as unknown as typeof fetch;
    expect((await handleAiRequest({ mode: "prompt", text: "mobile app calls core api" }, env, garbage)).body.error).toBe("bad_response");
  });

  it("finds the JSON object inside surrounding text", () => {
    expect(extractJson('Here you go: {"a": 1} hope it helps')).toEqual({ a: 1 });
    expect(extractJson("no json")).toBeNull();
  });
});

describe("review before saving and traceability (AI-06, AI-07)", () => {
  const prompt = "The web portal calls the order service. The order service stores data in PostgreSQL.";

  it("writes nothing to the model until a person applies the proposal", () => {
    const ws = emptyWorkspace();
    const proposal = draftToProposal(ws, draftFromText(prompt), { origin: "ai-prompt", source: prompt, engine: "test", targetDiagramId: null });
    const pending = saveProposal(ws, proposal);
    expect(Object.keys(pending.objects)).toHaveLength(0);
    expect(proposalCounts(proposal).pending).toBe(5);
    // Applying with nothing accepted saves nothing.
    const none = applyProposal(pending, proposal.id, "Khaled");
    expect(Object.keys(none.ws.objects)).toHaveLength(0);
    expect(none.ws.proposals[proposal.id].status).toBe("dismissed");
  });

  it("saves only accepted items and records the prompt, engine and approver", () => {
    let ws = emptyWorkspace();
    const proposal = draftToProposal(ws, draftFromText(prompt), { origin: "ai-prompt", source: prompt, engine: "test-engine", targetDiagramId: null });
    ws = setAllDecisions(saveProposal(ws, proposal), proposal.id, "accepted");
    // The reviewer renames one suggestion and rejects another.
    ws = updateProposal(ws, proposal.id, (p) => ({
      ...p,
      objects: p.objects.map((o) => (o.name === "Web portal" ? { ...o, name: "Customer portal" } : o.name === "PostgreSQL" ? { ...o, decision: "rejected" } : o)),
    }));
    const result = applyProposal(ws, proposal.id, "Khaled");
    expect(result.createdObjects).toBe(2);
    expect(result.createdRelationships).toBe(1); // the relationship to the rejected database is dropped
    const created = Object.values(result.ws.objects);
    expect(created.map((o) => o.name).sort()).toEqual(["Customer portal", "Order service"]);
    for (const o of created) {
      expect(o.provenance).toMatchObject({ origin: "ai-prompt", source: prompt, engine: "test-engine", proposalId: proposal.id, approvedBy: "Khaled" });
      expect(o.provenance.approvedAt).toBeTruthy();
    }
    expect(Object.values(result.ws.relationships)[0].provenance.approvedBy).toBe("Khaled");
    const diagram = result.ws.diagrams[result.diagramId!];
    expect(Object.keys(diagram.nodes)).toHaveLength(2);
    expect(visibleEdges(result.ws, diagram)).toHaveLength(1);
    expect(result.ws.proposals[proposal.id]).toMatchObject({ status: "applied", decidedBy: "Khaled" });
    // A decided proposal cannot be applied twice.
    expect(applyProposal(result.ws, proposal.id, "Khaled").ws).toBe(result.ws);
  });

  it("reuses an existing object with the same name instead of duplicating it", () => {
    let ws = demoWorkspace("Khaled");
    const before = Object.keys(ws.objects).length;
    const text = "The order service calls the loyalty service.";
    const proposal = draftToProposal(ws, draftFromText(text), { origin: "ai-prompt", source: text, engine: "test", targetDiagramId: null });
    expect(proposal.objects.find((o) => o.name === "Order service")?.matchId).toBeTruthy();
    ws = setAllDecisions(saveProposal(ws, proposal), proposal.id, "accepted");
    const result = applyProposal(ws, proposal.id, "Khaled");
    expect(result.reusedObjects).toBe(1);
    expect(result.createdObjects).toBe(1);
    expect(Object.keys(result.ws.objects)).toHaveLength(before + 1);
  });
});

describe("a proposal that arrived through the API", () => {
  it("creates what is new, changes only the fields that were sent, and stamps where it came from", () => {
    let ws = emptyWorkspace();
    const made = createObject(ws, { name: "Ledger", typeId: "database", owner: "Finance", description: "Old words" });
    ws = made.ws;
    const proposal: Proposal = {
      id: "prop_api", origin: "api", withoutDiagram: true, source: "Add the support assistant", engine: "API key: Coding agent", notes: "", createdAt: "2026-11-16T09:00:00.000Z", status: "pending", targetDiagramId: null,
      objects: [
        { key: "bot", name: "Support assistant", typeId: "ai-agent", description: "", technology: "", parentKey: null, decision: "pending", matchId: null, owner: "Support", provided: ["type", "owner"] },
        { key: "ledger", name: "Ledger", typeId: "database", description: "The book of record", technology: "", parentKey: null, decision: "pending", matchId: made.object.id, provided: ["description"] },
      ],
      relationships: [{ key: "r1", sourceKey: "bot", targetKey: "ledger", kind: "reads_writes", label: "", decision: "pending", protocol: "TLS", port: "", description: "" }],
    };
    ws = setAllDecisions(saveProposal(ws, proposal), proposal.id, "accepted");
    const result = applyProposal(ws, proposal.id, "Olivia");
    expect(result).toMatchObject({ createdObjects: 1, reusedObjects: 1, updatedObjects: 1, createdRelationships: 1, diagramId: null });
    const ledger = result.ws.objects[made.object.id];
    expect(ledger).toMatchObject({ description: "The book of record", owner: "Finance" });
    const bot = Object.values(result.ws.objects).find((o) => o.name === "Support assistant")!;
    expect(bot).toMatchObject({ typeId: "ai-agent", owner: "Support" });
    expect(bot.provenance).toMatchObject({ origin: "api", source: "Add the support assistant", engine: "API key: Coding agent", approvedBy: "Olivia" });
    expect(Object.values(result.ws.diagrams)).toHaveLength(0);
    expect(result.ws.proposals[proposal.id]).toMatchObject({ status: "applied", decidedBy: "Olivia" });
  });
});
