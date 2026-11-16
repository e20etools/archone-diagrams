import { describe, expect, it } from "vitest";
import { applyProposal, importUpdates, saveProposal } from "../ai/proposals";
import { createObject, createRelationship, emptyWorkspace, updateObject } from "../model";
import { apmBase, createApmHandler, type ApmData } from "./http";
import { APM_FIELDS, apmToProposal } from "./map";

const TOKEN = `apmf_${"a".repeat(64)}`;
const feeds: Record<string, unknown> = {
  applications: [
    { id: "t1", number: 1, name: "CyberArk", description: "Privileged access management.", vendor: "CyberArk", version: "14.x", category: "Secrets & Runtime Security" },
    { id: "t2", number: 2, name: "HashiCorp Vault", description: "Secrets storage.", vendor: "HashiCorp (IBM)", version: "1.20", category: "Secrets & Runtime Security" },
    { id: "t3", number: 3, name: "Jenkins", description: "", vendor: "", version: "", category: "Source Control, CI/CD & Artifacts" },
  ],
  classifications: [{ id: "t1", name: "CyberArk", classifications: { hosting: "on_premise", license: "commercial", license_model: "subscription", business_capability: "Security & Compliance", maturity: "normal" } }],
  lifecycle: [{ id: "t1", name: "CyberArk", lifecycle_status: "Tolerate" }, { id: "t2", name: "HashiCorp Vault", lifecycle_status: "Eliminate" }],
  integrations: [
    { source: "Jenkins", target: "HashiCorp Vault", type: "API", description: "Reads build secrets" },
    { source: "Jenkins", target: "CyberArk", type: "SSO", description: "" },
    { source: "Jenkins", target: "HashiCorp Vault", type: "API", description: "Listed twice" },
    { source: "Jenkins", target: "Unknown tool", type: "File", description: "" },
  ],
};
const data = (): ApmData => ({ ...(structuredClone(feeds) as Omit<ApmData, "host" | "fetchedAt">), host: "apm.example.com", fetchedAt: "2026-11-16T10:00:00.000Z" });

describe("the APM endpoint", () => {
  const seen: { url: string; auth: string | null }[] = [];
  const upstream = (options: { status?: number; user?: boolean } = {}) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") });
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify(options.user ? { id: "u1" } : {}), { status: options.user ? 200 : 401 });
      if (options.status) return new Response("no", { status: options.status });
      const dataset = /feeds\/([a-z]+)\.json$/.exec(url)?.[1] ?? "";
      return new Response(JSON.stringify(feeds[dataset] ?? { nope: true }), { status: 200 });
    }) as typeof fetch;
  const env = { APM_FEED_URL: "https://apm.example.com", SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon" };
  const post = (handler: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) => handler(new Request("https://app.example.com/api/apm", { method: "POST", headers: { "content-type": "application/json", host: "app.example.com", ...headers }, body: JSON.stringify(body) }));

  it("says whether APM is set up, without giving anything away", async () => {
    const status = async (e: Record<string, string>) => (await createApmHandler(() => e, upstream())(new Request("https://app.example.com/api/apm"))).json();
    expect(await status({})).toEqual({ configured: false, host: null, hasToken: false });
    expect(await status(env)).toEqual({ configured: true, host: "apm.example.com", hasToken: false });
    expect(await status({ ...env, APM_FEED_TOKEN: TOKEN })).toEqual({ configured: true, host: "apm.example.com", hasToken: true });
    for (const bad of ["http://apm.example.com", "https://user:pw@apm.example.com", "https://apm.example.com/?x=1", "not a url"]) expect(apmBase({ APM_FEED_URL: bad }), bad).toBeNull();
  });

  it("reads the four feeds from the configured address with a pasted token, and from nowhere else", async () => {
    seen.length = 0;
    const response = await post(createApmHandler(() => env, upstream()), { token: TOKEN, url: "https://evil.example" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApmData;
    expect(body.host).toBe("apm.example.com");
    expect(body.applications).toHaveLength(3);
    expect(body.integrations).toHaveLength(4);
    expect(seen.map((s) => s.url)).toEqual(["applications", "classifications", "lifecycle", "integrations"].map((d) => `https://apm.example.com/api/public/feeds/${d}.json`));
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect((await post(createApmHandler(() => env, upstream()), { token: "apmf_short" })).status).toBe(400);
    expect((await post(createApmHandler(() => ({}), upstream()), { token: TOKEN })).status).toBe(501);
  });

  it("uses the server's own token only for someone who is signed in", async () => {
    const kept = { ...env, APM_FEED_TOKEN: TOKEN };
    expect((await post(createApmHandler(() => kept, upstream({ user: false })), {})).status).toBe(401);
    expect((await post(createApmHandler(() => kept, upstream({ user: false })), {}, { authorization: "Bearer stolen" })).status).toBe(401);
    seen.length = 0;
    const ok = await post(createApmHandler(() => kept, upstream({ user: true })), {}, { authorization: "Bearer session" });
    expect(ok.status).toBe(200);
    expect(seen[0]).toEqual({ url: "https://proj.supabase.co/auth/v1/user", auth: "Bearer session" });
    // Without an accounts service there is nobody to check, so the kept token is not used at all.
    expect((await post(createApmHandler(() => ({ APM_FEED_URL: env.APM_FEED_URL, APM_FEED_TOKEN: TOKEN }), upstream({ user: true })), {}, { authorization: "Bearer session" })).status).toBe(401);
    expect(((await (await post(createApmHandler(() => env, upstream()), {})).json()) as { error: string }).error).toBe("token_needed");
  });

  it("refuses another site, and says plainly what APM refused", async () => {
    const handler = createApmHandler(() => env, upstream());
    expect((await post(handler, { token: TOKEN }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(handler, { token: TOKEN }, { origin: "https://app.example.com" })).status).toBe(200);
    const refused = await post(createApmHandler(() => env, upstream({ status: 403 })), { token: TOKEN });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { message: string }).message).toContain("expired or revoked");
    expect((await post(createApmHandler(() => env, upstream({ status: 429 })), { token: TOKEN })).status).toBe(429);
    const broken = createApmHandler(() => env, (async () => new Response('{"not":"a list"}', { status: 200 })) as typeof fetch);
    expect(((await (await post(broken, { token: TOKEN })).json()) as { message: string }).message).toContain("did not return a list");
    expect((await handler(new Request("https://app.example.com/api/apm", { method: "DELETE" }))).status).toBe(405);
  });
});

describe("applications from APM as a draft", () => {
  it("brings each application with its facts as fields, and integrations as relationships", () => {
    const { proposal, counts } = apmToProposal(emptyWorkspace("T"), data());
    expect(counts).toEqual({ applications: 3, fresh: 3, matched: 0, relationships: 2, skippedRelationships: 2 });
    expect(proposal).toMatchObject({ origin: "import", importKind: "apm", source: "APM at apm.example.com", status: "pending", withoutDiagram: true });
    const cyber = proposal.objects[0];
    expect(cyber).toMatchObject({ name: "CyberArk", typeId: "application", lifecycle: "active", matchId: null, description: "Privileged access management." });
    expect(cyber.fields).toEqual({ "APM id": "t1", "APM number": "1", Vendor: "CyberArk", Version: "14.x", Category: "Secrets & Runtime Security", TIME: "Tolerate", Hosting: "On premise", "Business capability": "Security & Compliance", License: "Commercial, Subscription" });
    expect(proposal.objects[1]).toMatchObject({ name: "HashiCorp Vault", lifecycle: "deprecated" });
    expect(proposal.objects[2].lifecycle).toBeUndefined();
    expect(proposal.objects[2].provided).toEqual(["fields"]);
    expect(proposal.relationships.map((r) => `${r.sourceKey} ${r.kind} ${r.targetKey} ${r.label}`)).toEqual(["a3 calls a2 API", "a3 depends_on a1 SSO"]);
  });

  it("is applied through the usual review, and a second import updates instead of duplicating", () => {
    let ws = emptyWorkspace("T");
    const first = apmToProposal(ws, data()).proposal;
    ws = saveProposal(ws, { ...first, objects: first.objects.map((o) => ({ ...o, decision: "accepted" as const })), relationships: first.relationships.map((r) => ({ ...r, decision: "accepted" as const })) });
    const applied = applyProposal(ws, first.id, "Sara");
    expect(applied).toMatchObject({ createdObjects: 3, createdRelationships: 2 });
    ws = applied.ws;
    const cyber = Object.values(ws.objects).find((o) => o.name === "CyberArk")!;
    expect(cyber.fields[APM_FIELDS.vendor]).toBe("CyberArk");
    expect(cyber.provenance).toMatchObject({ origin: "import", engine: "APM import", approvedBy: "Sara" });

    // Here the object gets an owner, a kind and a field of its own; APM renames it and bumps the version.
    ws = updateObject(ws, cyber.id, { owner: "Security", typeId: "service", fields: { ...cyber.fields, Tier: "1" } });
    const later = data();
    later.applications[0] = { ...later.applications[0], name: "CyberArk PAM", version: "15.0" };
    later.applications.pop();
    later.integrations = [];
    const again = apmToProposal(ws, later);
    expect(again.counts).toMatchObject({ applications: 2, fresh: 0, matched: 2, relationships: 0 });
    expect(again.gone).toEqual(["Jenkins"]);
    expect(again.proposal.notes).toContain("No longer active in APM, and left untouched here: Jenkins.");
    const row = again.proposal.objects[0];
    expect(row).toMatchObject({ matchId: cyber.id, typeId: "service" });
    expect(importUpdates(ws, row)).toEqual(["Details"]);
    ws = saveProposal(ws, { ...again.proposal, objects: again.proposal.objects.map((o) => ({ ...o, decision: "accepted" as const })) });
    const second = applyProposal(ws, again.proposal.id, "Sara");
    expect(second).toMatchObject({ createdObjects: 0, updatedObjects: 1 });
    const after = second.ws.objects[cyber.id];
    expect(after).toMatchObject({ name: "CyberArk", owner: "Security", typeId: "service" });
    expect(after.fields).toMatchObject({ Version: "15.0", Tier: "1", "APM id": "t1" });
    expect(Object.keys(second.ws.objects)).toHaveLength(3);
  });

  it("matches by name the first time, and does not propose a relationship the model already has", () => {
    let ws = emptyWorkspace("T");
    const jenkins = createObject(ws, { name: "jenkins", typeId: "service" });
    const vault = createObject(jenkins.ws, { name: "HashiCorp Vault", typeId: "database" });
    ws = createRelationship(vault.ws, { sourceId: jenkins.object.id, targetId: vault.object.id, kind: "calls" }).ws;
    const { proposal, counts } = apmToProposal(ws, data());
    expect(counts).toMatchObject({ matched: 2, fresh: 1, relationships: 1, skippedRelationships: 3 });
    expect(proposal.objects.find((o) => o.name === "Jenkins")).toMatchObject({ matchId: jenkins.object.id, typeId: "service" });
    expect(proposal.relationships.map((r) => r.label)).toEqual(["SSO"]);
  });
});
