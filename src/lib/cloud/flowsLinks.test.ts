import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelObject, Relationship } from "../types";
import { fromRow, toRow } from "./rows";
import type { DiagramMeta } from "./tables";

/**
 * Flows, links and protected live links against the real migrations (PGlite): what is stored
 * comes back as it was sent, a scenario takes it along, and what leaves without a sign-in
 * leaves without links, and only with the password when the link has one.
 */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let ws = "";

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string | null, run: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [who ? JSON.stringify({ sub: ids[who], email: `${who}@example.com` }) : ""]);
    await tx.exec(who ? "set local role authenticated" : "set local role anon");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}

const stamp = "2026-11-16T09:00:00.000Z";
const object = (id: string, name: string, extra: Partial<ModelObject> = {}): ModelObject => ({
  id, typeId: "service", name, description: "", owner: "", lifecycle: "active", tags: [], parentId: null, technology: "", fields: {},
  provenance: { origin: "manual" }, createdAt: stamp, updatedAt: stamp, ...extra,
});
const api = object("api", "API", { links: [{ label: "Repository", url: "https://github.com/team/api" }, { label: "", url: "https://grafana.example.com/d/api" }] });
const web = object("web", "Web", { componentId: "applications.web-application" });
const calls: Relationship = {
  id: "r1", sourceId: "web", targetId: "api", kind: "calls", label: "asks", protocol: "HTTPS", port: "443", description: "",
  links: [{ label: "Contract", url: "https://example.com/openapi.json" }], provenance: { origin: "manual" }, createdAt: stamp, updatedAt: stamp,
};
const checkout: DiagramMeta = {
  id: "d1", name: "Checkout", description: "How paying works", viewType: "custom", scopeId: null, direction: "TB", hiddenRelationshipIds: [], edgeKinds: null, colorBy: "type",
  flows: [{ id: "f1", name: "A customer pays", description: "", steps: [{ id: "s1", fromId: "web", toId: "api", text: "sends the basket" }, { id: "s2", fromId: "api", toId: "api", text: "works out the tax" }] }],
  createdAt: stamp, updatedAt: stamp,
};

async function upsert(q: Q, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const json = new Set(["fields", "provenance", "links", "flows", "acknowledged"]);
  const values = columns.map((c) => (json.has(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
  const key = "workspace_id, id";
  await q(`insert into public.${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (${key}) do update set ${columns.filter((c) => c !== "workspace_id" && c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`, values);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "vera"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Shop') as id")))[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, ids.edgar, ids.vera]);
  await as("edgar", async (q) => {
    await upsert(q, "objects", toRow("objects", ws, api.id, api));
    await upsert(q, "objects", toRow("objects", ws, web.id, web));
    await upsert(q, "relationships", toRow("relationships", ws, calls.id, calls));
    await upsert(q, "diagrams", toRow("diagrams", ws, checkout.id, checkout));
    await q("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd1', 'web', 0, 0), ($1, 'd1', 'api', 300, 0)", [ws]);
  });
}, 60_000);

const read = async (who: string, table: "objects" | "relationships" | "diagrams", workspace = ws) => {
  const rows = await as(who, (q) => q(`select * from public.${table} where workspace_id = $1 order by id`, [workspace]));
  return Object.fromEntries(rows.map((r) => { const { key, value } = fromRow(table, r); return [key, value]; })) as Record<string, any>;
};

describe("flows and links in the database", () => {
  it("come back as they were sent, and an item without any reads back without the key", async () => {
    const objects = await read("vera", "objects");
    expect(objects.api).toEqual(api);
    expect(objects.web).toEqual(web);
    expect("links" in objects.web).toBe(false);
    expect((await read("vera", "relationships")).r1).toEqual(calls);
    expect((await read("vera", "diagrams")).d1).toEqual(checkout);
  });

  it("clear when the last link or flow is removed", async () => {
    const bare = { ...web, links: [{ label: "Site", url: "https://shop.example.com" }] };
    await as("edgar", (q) => upsert(q, "objects", toRow("objects", ws, web.id, bare)));
    expect((await read("vera", "objects")).web).toEqual(bare);
    await as("edgar", (q) => upsert(q, "objects", toRow("objects", ws, web.id, web)));
    expect((await read("vera", "objects")).web).toEqual(web);
  });

  it("refuse what is not a list, and more than the limits allow", async () => {
    await expect(as("edgar", (q) => q("update public.objects set links = '{\"url\":\"x\"}' where workspace_id = $1 and id = 'web'", [ws]))).rejects.toThrow(/check constraint/);
    const many = JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ label: "", url: `https://example.com/${i}` })));
    await expect(as("edgar", (q) => q("update public.relationships set links = $2 where workspace_id = $1", [ws, many]))).rejects.toThrow(/check constraint/);
    const flows = JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ id: `f${i}`, name: "x", description: "", steps: [] })));
    await expect(as("edgar", (q) => q("update public.diagrams set flows = $2 where workspace_id = $1", [ws, flows]))).rejects.toThrow(/check constraint/);
    // A viewer changes neither.
    await as("vera", (q) => q("update public.diagrams set flows = null where workspace_id = $1", [ws]));
    expect((await read("vera", "diagrams")).d1.flows).toHaveLength(1);
  });

  it("read rows written by something else without falling over", () => {
    const odd = fromRow("objects", { ...toRow("objects", ws, api.id, api), links: [{ url: "https://ok.example.com" }, { label: "no address" }, "text", null] }).value as ModelObject;
    expect(odd.links).toEqual([{ label: "", url: "https://ok.example.com" }]);
    const flows = fromRow("diagrams", { ...toRow("diagrams", ws, checkout.id, checkout), flows: [{ id: "f", steps: [{ id: "s", fromId: "a", toId: "b" }, { id: "broken" }] }, { name: "no id" }, 7] }).value as DiagramMeta;
    expect(flows.flows).toEqual([{ id: "f", name: "", description: "", steps: [{ id: "s", fromId: "a", toId: "b", text: "" }] }]);
  });

  it("keep the library component an object was made from, and clear it when it is taken away", async () => {
    expect((await read("vera", "objects")).web.componentId).toBe("applications.web-application");
    expect("componentId" in (await read("vera", "objects")).api).toBe(false);
    await expect(as("edgar", (q) => q("update public.objects set component_id = $2 where workspace_id = $1 and id = 'api'", [ws, "x".repeat(121)]))).rejects.toThrow(/check constraint/);
  });

  it("go into a scenario with the rest of the model", async () => {
    const scenario = (await as("edgar", (q) => q("select public.create_scenario($1, 'Next year') as id", [ws])))[0].id;
    expect((await read("edgar", "objects", scenario)).api.links).toEqual(api.links);
    expect((await read("edgar", "objects", scenario)).web.componentId).toBe("applications.web-application");
    expect((await read("edgar", "relationships", scenario)).r1.links).toEqual(calls.links);
    expect((await read("edgar", "diagrams", scenario)).d1.flows).toEqual(checkout.flows);
  });

  it("are written down in the audit log", async () => {
    const entries = await as("olivia", (q) => q("select entity, entity_name, action, changes from public.audit_log where workspace_id = $1 and entity = 'object' and entity_name = 'Web' order by id", [ws]));
    expect(entries.map((e) => e.action)).toEqual(["created", "updated", "updated"]);
    expect(JSON.stringify(entries[1].changes)).toMatch(/shop\.example\.com/);
  });
});

describe("what leaves without a sign-in", () => {
  let token = "";
  const view = async (t: string, password?: string) => (await as(null, (q) => (password === undefined ? q("select public.embed_view($1) as v", [t]) : q("select public.embed_view($1, $2) as v", [t, password]))))[0].v as Record<string, any>;

  it("a live link shows the flows of its diagram and none of the links", async () => {
    token = (await as("edgar", (q) => q("select public.create_embed($1, 'd1') as t", [ws])))[0].t;
    const v = await view(token);
    expect(v.status).toBe("ok");
    expect(v.diagram.flows).toEqual(checkout.flows);
    expect(v.objects.find((o: any) => o.id === "api")).toMatchObject({ name: "API" });
    expect(JSON.stringify(v)).not.toMatch(/github\.com|grafana|openapi/);
    expect((await as("edgar", (q) => q("select protected, expires_at from public.embeds where token = $1", [token])))[0]).toEqual({ protected: false, expires_at: null });
  });

  it("the public trust page shows neither flows nor links", async () => {
    const page = (await as("olivia", (q) => q("select public.set_trust_page($1, true, 'Shop', '', '', 'd1') as v", [ws])))[0].v;
    const v = (await as(null, (q) => q("select public.trust_view($1) as v", [page.token])))[0].v;
    expect(v.status).toBe("ok");
    expect(v.diagram).toMatchObject({ id: "d1", name: "Checkout" });
    expect(v.diagram).not.toHaveProperty("flows");
    expect(JSON.stringify(v)).not.toMatch(/sends the basket|github\.com|grafana|openapi/);
  });
});

describe("a protected live link", () => {
  const view = async (t: string, password?: string) => (await as(null, (q) => (password === undefined ? q("select public.embed_view($1) as v", [t]) : q("select public.embed_view($1, $2) as v", [t, password]))))[0].v as Record<string, any>;
  let token = "";
  const secret = "correct horse 42";

  it("needs a password of some length and a date that has not passed", async () => {
    await expect(as("edgar", (q) => q("select public.create_embed($1, 'd1', 'short')", [ws]))).rejects.toThrow(/at least 8 characters/);
    await expect(as("edgar", (q) => q("select public.create_embed($1, 'd1', null, now() - interval '1 minute')", [ws]))).rejects.toThrow(/date in the future/);
    await expect(as("vera", (q) => q("select public.create_embed($1, 'd1', $2)", [ws, secret]))).rejects.toThrow(/Only owners and editors/);
    token = (await as("edgar", (q) => q("select public.create_embed($1, 'd1', $2) as t", [ws, secret])))[0].t;
    expect((await as("edgar", (q) => q("select protected from public.embeds where token = $1", [token])))[0]).toEqual({ protected: true });
  });

  it("shows nothing without the password, and the diagram with it", async () => {
    expect(await view(token)).toEqual({ status: "locked", wrong: false });
    expect(await view(token, "")).toEqual({ status: "locked", wrong: false });
    expect(await view(token, "not the password")).toEqual({ status: "locked", wrong: true });
    const v = await view(token, secret);
    expect(v).toMatchObject({ status: "ok", diagram: { id: "d1" } });
    // A right password clears the count of wrong ones.
    expect((await db.query("select failed, locked_until from public.embed_secrets")).rows).toEqual([{ failed: 0, locked_until: null }]);
  });

  it("keeps the password where neither the app nor the audit log can read it", async () => {
    for (const who of ["olivia", "edgar", null]) await expect(as(who, (q) => q("select * from public.embed_secrets"))).rejects.toThrow(/permission denied/);
    const stored = (await db.query<{ salt: string; hash: string }>("select salt, hash from public.embed_secrets")).rows[0];
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.hash).not.toContain(secret);
    const log = JSON.stringify((await db.query("select * from public.audit_log")).rows);
    expect(log).not.toContain(secret);
    expect(log).not.toContain(stored.hash);
    expect(log).not.toContain(stored.salt);
    await expect(as("edgar", (q) => q("select public.embed_password_hash('a', 'b')"))).rejects.toThrow(/permission denied/);
    // The same password on another link is stored differently.
    await as("edgar", (q) => q("select public.create_embed($1, 'd1', $2)", [ws, secret]));
    const hashes = (await db.query<{ hash: string }>("select hash from public.embed_secrets")).rows.map((r) => r.hash);
    expect(new Set(hashes).size).toBe(2);
  });

  it("shuts for a while after five wrong passwords, even for the right one", async () => {
    for (let i = 0; i < 4; i++) expect(await view(token, `guess ${i}`)).toEqual({ status: "locked", wrong: true });
    expect(await view(token, "guess 5")).toEqual({ status: "locked", wrong: true });
    expect(await view(token, secret)).toEqual({ status: "throttled", minutes: 15 });
    expect(await view(token)).toEqual({ status: "throttled", minutes: 15 });
    // When the time is up the right password opens it again.
    await db.query("update public.embed_secrets set locked_until = now() - interval '1 second'");
    expect((await view(token, secret)).status).toBe("ok");
  });

  it("stops working on its date, and when it is switched off", async () => {
    const dated = (await as("edgar", (q) => q("select public.create_embed($1, 'd1', null, now() + interval '1 day') as t", [ws])))[0].t;
    expect((await view(dated)).status).toBe("ok");
    await db.query("update public.embeds set expires_at = now() - interval '1 second' where token = $1", [dated]);
    expect(await view(dated)).toEqual({ status: "expired" });
    const id = (await as("edgar", (q) => q("select id from public.embeds where token = $1", [token])))[0].id;
    await as("edgar", (q) => q("select public.revoke_embed($1)", [id]));
    expect(await view(token, secret)).toEqual({ status: "gone" });
  });
});
