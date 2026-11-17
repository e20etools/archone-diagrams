import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { OBJECT_TYPES } from "../catalog";
import { fromRow, type Row } from "../cloud/rows";
import { RELATION_KINDS, processModelSchema } from "../types";
import { createApiHandler } from "./http";

/**
 * The REST API end to end: an HTTP request goes through the same handler the hosted function
 * runs, and the database call it makes is answered by the real migrations on a real Postgres
 * (PGlite), called without a signed-in user exactly as the hosted function calls it.
 */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let workspace = "";
let other = "";
const keys: Record<string, string> = {};

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string | null, run: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [who ? JSON.stringify({ sub: ids[who] }) : ""]);
    await tx.exec(who ? "set local role authenticated" : "set local role anon");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}

/** Stands in for the network between the function and the database's REST interface. */
const upstream = async (input: string, init?: RequestInit): Promise<Response> => {
  const name = input.split("/rest/v1/rpc/")[1];
  const args = JSON.parse(String(init?.body ?? "{}"));
  if (name !== "api_request") return new Response("{}", { status: 404 });
  const rows = await as(null, (q) => q("select public.api_request($1, $2, $3, $4, $5) as reply", [args.p_key, args.p_method, args.p_path, JSON.stringify(args.p_query), args.p_body === null ? null : JSON.stringify(args.p_body)]));
  return new Response(JSON.stringify(rows[0].reply), { status: 200, headers: { "Content-Type": "application/json" } });
};
const handler = createApiHandler(() => ({ SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon" }), upstream);
async function call(method: string, path: string, body?: unknown, key = keys.write) {
  const response = await handler(
    new Request(`https://project.supabase.co/functions/v1/api/v1${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "vera", "stranger"]) {
    const { rows } = await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`${who}@example.com`]);
    ids[who] = rows[0].id;
  }
  workspace = (await as("olivia", (q) => q("select public.create_workspace('Payments') as id")))[0].id;
  other = (await as("stranger", (q) => q("select public.create_workspace('Someone else') as id")))[0].id;
  for (const [who, role] of [["edgar", "editor"], ["vera", "viewer"]]) await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspace, ids[who], role]);
}, 60_000);

describe("API keys", () => {
  it("are created by an owner, shown once, and stored only as a hash", async () => {
    await expect(as("edgar", (q) => q("select * from public.create_api_key($1, 'CI', 'write')", [workspace]))).rejects.toThrow(/Only an owner/);
    await expect(as("olivia", (q) => q("select * from public.create_api_key($1, 'CI', 'admin')", [workspace]))).rejects.toThrow(/read, propose or write/);
    for (const access of ["read", "write"]) keys[access] = (await as("olivia", (q) => q("select * from public.create_api_key($1, $2, $3)", [workspace, `${access} key`, access])))[0].key;
    keys.other = (await as("stranger", (q) => q("select * from public.create_api_key($1, 'theirs', 'write')", [other])))[0].key;
    expect(keys.write).toMatch(/^ark_[0-9a-f]{44}$/);
    const listed = await as("olivia", (q) => q("select name, prefix, access, revoked_at from public.api_keys order by name"));
    expect(listed).toEqual([
      { name: "read key", prefix: keys.read.slice(0, 12), access: "read", revoked_at: null },
      { name: "write key", prefix: keys.write.slice(0, 12), access: "write", revoked_at: null },
    ]);
    await expect(as("olivia", (q) => q("select key_hash from public.api_keys"))).rejects.toThrow(/permission denied/);
    expect(await as("edgar", (q) => q("select id from public.api_keys"))).toEqual([]);
    const stored = await db.query<{ key_hash: string }>("select key_hash from public.api_keys where name = 'write key'");
    expect(stored.rows[0].key_hash).not.toContain(keys.write.slice(4));
  });
});

describe("REST API", () => {
  let ledger = "";
  let database = "";
  let relationship = "";

  it("refuses a request without a valid key, and describes itself without one", async () => {
    expect(await call("GET", "/objects", undefined, "")).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
    expect((await call("GET", "/objects", undefined, "ark_wrong")).status).toBe(401);
    const spec = await call("GET", "/openapi.json", undefined, "");
    expect(spec.status).toBe(200);
    expect(spec.body.servers[0].url).toBe("https://project.supabase.co/functions/v1/api/v1");
    expect(Object.keys(spec.body.paths)).toEqual(["/", "/model", "/objects", "/objects/{id}", "/relationships", "/relationships/{id}", "/diagrams", "/diagrams/{id}", "/processes", "/processes/{id}", "/proposals", "/proposals/{id}"]);
    expect((await handler(new Request("https://x/functions/v1/api/v1/objects", { method: "OPTIONS" }))).headers.get("access-control-allow-origin")).toBe("*");
  });

  it("knows the same object types and relationship kinds as the application", async () => {
    const { rows } = await db.query<{ id: string; level: number }>("select id, level from public.object_types");
    expect(Object.fromEntries(rows.map((r) => [r.id, r.level]))).toEqual(Object.fromEntries(OBJECT_TYPES.map((t) => [t.id, t.level])));
    const spec = (await call("GET", "/openapi.json", undefined, "")).body;
    expect(spec.components.schemas.ObjectInput.properties.typeId.enum).toEqual(OBJECT_TYPES.map((t) => t.id));
    // "Then", the step-to-step relationship of a process, is drawn in the app; the API does not take it yet.
    expect(spec.components.schemas.RelationshipInput.properties.kind.enum).toEqual(RELATION_KINDS.filter((k) => k !== "flows_to"));
  });

  it("creates objects and says exactly what is wrong with a bad one", async () => {
    const made = await call("POST", "/objects", { name: "  General   ledger ", typeId: "service", owner: "Finance", tags: ["PCI", "pci", " core "], fields: { tier: "1" } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "General ledger", typeId: "service", owner: "Finance", lifecycle: "active", tags: ["core", "pci"], parentId: null, fields: { tier: "1" }, origin: "api" });
    ledger = made.body.id;
    expect(ledger).toMatch(/^obj_[0-9a-f]{12}$/);
    database = (await call("POST", "/objects", { name: "Ledger DB", typeId: "database", technology: "PostgreSQL" })).body.id;

    expect((await call("POST", "/objects", { typeId: "service" })).body.error.message).toBe('"name" is required.');
    expect((await call("POST", "/objects", { name: "X", typeId: "spaceship" })).body.error.message).toMatch(/"typeId" has to be one of: domain, actor/);
    expect((await call("POST", "/objects", { name: "X", typeId: "service", lifecycle: "zombie" })).status).toBe(422);
    expect((await call("POST", "/objects", { name: "X", typeId: "service", tags: "pci" })).status).toBe(422);
    expect((await call("POST", "/objects", { name: 7, typeId: "service" })).body.error.message).toBe('"name" has to be text.');
    expect((await call("POST", "/objects", "{not json")).body.error).toMatchObject({ code: "invalid", message: "The request body is not valid JSON." });
    expect((await call("POST", "/objects", [1, 2])).status).toBe(400);
    // The item is saved as a row the application reads like any other, with where it came from.
    const row = (await db.query("select * from public.objects where id = $1", [ledger])).rows[0] as Row;
    expect(fromRow("objects", row).value).toMatchObject({ name: "General ledger", provenance: { origin: "api", source: "API key: write key" } });
  });

  it("keeps the nesting rule: a parent has to be of a higher level", async () => {
    const system = (await call("POST", "/objects", { name: "Finance platform", typeId: "system" })).body.id;
    expect((await call("PATCH", `/objects/${ledger}`, { parentId: system })).body.parentId).toBe(system);
    expect((await call("PATCH", `/objects/${system}`, { parentId: ledger })).body.error.message).toBe("A system cannot sit inside a service. The parent has to be of a higher level.");
    expect((await call("PATCH", `/objects/${ledger}`, { parentId: "obj_missing" })).status).toBe(422);
    // Changing a parent's type must not strand what is inside it.
    expect((await call("PATCH", `/objects/${system}`, { typeId: "component" })).body.error.message).toMatch(/1 object\(s\) inside this one would no longer fit/);
    expect((await call("PATCH", `/objects/${ledger}`, { parentId: null })).body.parentId).toBeNull();
  });

  it("reads one object, changes only the fields sent, and filters and pages the list", async () => {
    expect((await call("GET", `/objects/${ledger}`)).body.name).toBe("General ledger");
    const changed = await call("PATCH", `/objects/${ledger}`, { lifecycle: "deprecated", description: "Being replaced" });
    expect(changed.body).toMatchObject({ name: "General ledger", owner: "Finance", lifecycle: "deprecated", description: "Being replaced", tags: ["core", "pci"] });
    expect((await call("GET", "/objects/obj_nope")).status).toBe(404);
    const names = async (query: string) => (await call("GET", `/objects${query}`)).body.data.map((o: { name: string }) => o.name).sort();
    expect(await names("?type=database")).toEqual(["Ledger DB"]);
    expect(await names("?tag=PCI")).toEqual(["General ledger"]);
    expect(await names("?owner=finance&lifecycle=deprecated")).toEqual(["General ledger"]);
    expect(await names("?q=ledger")).toEqual(["General ledger", "Ledger DB"]);
    expect(await names("?updatedSince=2999-01-01T00:00:00Z")).toEqual([]);
    expect((await call("GET", "/objects?updatedSince=not-a-date")).status).toBe(422);
    const first = (await call("GET", "/objects?limit=2")).body;
    expect(first.data).toHaveLength(2);
    const second = (await call("GET", `/objects?limit=2&cursor=${first.nextCursor}`)).body;
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it("creates relationships once, and refuses ones that join nothing", async () => {
    const made = await call("POST", "/relationships", { sourceId: ledger, targetId: database, kind: "reads_writes", label: "stores postings", protocol: "JDBC", port: "5432" });
    expect(made.status).toBe(201);
    relationship = made.body.id;
    expect(made.body).toMatchObject({ sourceId: ledger, targetId: database, kind: "reads_writes", protocol: "JDBC", origin: "api" });
    const again = await call("POST", "/relationships", { sourceId: ledger, targetId: database, kind: "reads_writes" });
    expect([again.status, again.body.id]).toEqual([200, relationship]);
    expect((await call("POST", "/relationships", { sourceId: ledger, targetId: ledger })).status).toBe(422);
    expect((await call("POST", "/relationships", { sourceId: ledger, targetId: "obj_missing" })).status).toBe(422);
    expect((await call("POST", "/relationships", { sourceId: ledger, targetId: database, kind: "likes" })).body.error.message).toMatch(/"kind" has to be one of: calls,/);
    expect((await call("PATCH", `/relationships/${relationship}`, { label: "writes postings" })).body.label).toBe("writes postings");
    expect((await call("PATCH", `/relationships/${relationship}`, { targetId: ledger })).status).toBe(422);
    expect((await call("GET", `/relationships?object=${database}`)).body.data).toHaveLength(1);
    expect((await call("GET", "/relationships?kind=calls")).body.data).toHaveLength(0);
  });

  it("creates a diagram with its boxes, moves them and takes them off", async () => {
    const made = await call("POST", "/diagrams", { name: "Ledger overview", direction: "LR", nodes: [{ objectId: ledger, x: 0, y: 0 }, { objectId: database, x: 300, y: 0 }] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "Ledger overview", viewType: "custom", direction: "LR" });
    expect(made.body.nodes.map((n: { objectId: string }) => n.objectId).sort()).toEqual([database, ledger].sort());
    const id = made.body.id;
    const moved = await call("PATCH", `/diagrams/${id}`, { name: "Ledger", nodes: [{ objectId: database, x: 300, y: 200, pinned: false }], removeNodes: [ledger] });
    expect(moved.body.nodes).toEqual([{ objectId: database, x: 300, y: 200, pinned: false }]);
    expect((await call("POST", "/diagrams", { name: "Bad", nodes: [{ objectId: "obj_missing" }] })).status).toBe(422);
    // A request that fails part-way leaves nothing behind.
    expect((await call("GET", "/diagrams")).body.data.map((d: { name: string }) => d.name)).toEqual(["Ledger"]);
    const model = (await call("GET", "/model")).body;
    expect([model.workspace.name, model.objects.length, model.relationships.length, model.diagrams.length]).toEqual(["Payments", 3, 1, 1]);
  });

  it("lets a read key read and nothing else, and keeps every key inside its own workspace", async () => {
    expect((await call("GET", "/", undefined, keys.read)).body).toMatchObject({ workspace: { name: "Payments" }, access: "read" });
    expect((await call("GET", "/objects", undefined, keys.read)).body.data).toHaveLength(3);
    for (const [method, path] of [["POST", "/objects"], ["PATCH", `/objects/${ledger}`], ["DELETE", `/objects/${ledger}`]]) {
      expect(await call(method, path, method === "DELETE" ? undefined : { name: "X", typeId: "service" }, keys.read)).toMatchObject({ status: 403, body: { error: { code: "read_only" } } });
    }
    expect((await call("GET", "/objects", undefined, keys.other)).body.data).toEqual([]);
    expect((await call("GET", `/objects/${ledger}`, undefined, keys.other)).status).toBe(404);
    expect((await call("PATCH", `/objects/${ledger}`, { name: "Taken over" }, keys.other)).status).toBe(404);
    expect((await call("POST", "/relationships", { sourceId: ledger, targetId: database }, keys.other)).status).toBe(422);
    expect((await call("GET", `/objects/${ledger}`)).body.name).toBe("General ledger");
  });

  it("deletes an object the way the application does: its arrows and boxes go, what was inside moves up", async () => {
    const system = (await call("GET", "/objects?type=system")).body.data[0].id;
    await call("PATCH", `/objects/${database}`, { parentId: system });
    const component = (await call("POST", "/objects", { name: "Posting engine", typeId: "component", parentId: ledger })).body.id;
    await call("PATCH", `/objects/${ledger}`, { parentId: system });
    expect((await call("DELETE", `/objects/${ledger}`)).status).toBe(204);
    expect((await call("GET", `/objects/${ledger}`)).status).toBe(404);
    expect((await call("GET", `/objects/${component}`)).body.parentId).toBe(system);
    expect((await call("GET", `/relationships/${relationship}`)).status).toBe(404);
    expect((await call("DELETE", `/objects/${ledger}`)).status).toBe(404);
    // Deleted through the API means marked deleted, so open browsers see it go.
    expect((await db.query("select deleted from public.objects where id = $1", [ledger])).rows[0]).toEqual({ deleted: true });
  });

  it("answers unknown addresses and methods plainly", async () => {
    expect((await call("GET", "/widgets")).body.error.message).toMatch(/The resources are \/objects/);
    expect((await call("GET", "/objects/a/b")).status).toBe(404);
    expect((await call("DELETE", "/objects")).status).toBe(405);
    expect((await handler(new Request("https://x/functions/v1/api/objects"))).status).toBe(404);
    const unset = createApiHandler(() => ({}), upstream);
    expect((await unset(new Request("https://x/api/v1/objects"))).status).toBe(501);
    const down = createApiHandler(() => ({ SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "a" }), async () => {
      throw new Error("offline");
    });
    expect((await down(new Request("https://x/api/v1/objects", { headers: { "x-api-key": keys.read } }))).status).toBe(502);
  });

  it("stops a key that calls more than 300 times in a minute, and a revoked key at once", async () => {
    const spare = (await as("olivia", (q) => q("select * from public.create_api_key($1, 'spare', 'read')", [workspace])))[0];
    await db.query("insert into public.api_usage (key_id, minute, calls) values ($1, date_trunc('minute', now()), 300) on conflict (key_id, minute) do update set calls = 300", [spare.id]);
    expect(await call("GET", "/objects", undefined, spare.key)).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
    await expect(as("edgar", (q) => q("select public.revoke_api_key($1)", [spare.id]))).rejects.toThrow(/not an owner/);
    await as("olivia", (q) => q("select public.revoke_api_key($1)", [spare.id]));
    expect((await call("GET", "/objects", undefined, spare.key)).status).toBe(401);
    expect((await db.query("select last_used_at is not null as used from public.api_keys where name = 'write key'")).rows[0]).toEqual({ used: true });
  });

  it("cannot be reached around the key: the API's inner functions are closed to everyone", async () => {
    for (const who of [null, "olivia"]) {
      await expect(as(who, (q) => q("select public.api_objects($1, 'GET', null, '{}', null, 'x')", [workspace]))).rejects.toThrow(/permission denied/);
      await expect(as(who, (q) => q("select * from public.api_usage"))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("webhooks", () => {
  let secret = "";

  it("signs with HMAC-SHA256 exactly as other platforms do", async () => {
    for (const [key, message] of [["key", "The quick brown fox jumps over the lazy dog"], ["k".repeat(100), "longer than a block"], ["", ""]]) {
      const { rows } = await db.query<{ mac: string }>("select encode(public.hmac_sha256(convert_to($1, 'UTF8'), convert_to($2, 'UTF8')), 'hex') as mac", [key, message]);
      expect(rows[0].mac).toBe(createHmac("sha256", key).update(message).digest("hex"));
    }
  });

  it("are added by an owner, to public https addresses only", async () => {
    await expect(as("edgar", (q) => q("select * from public.create_webhook($1, 'https://example.com/hook')", [workspace]))).rejects.toThrow(/Only an owner/);
    for (const url of ["http://example.com/hook", "https://localhost/hook", "https://10.0.0.5/hook", "https://[::1]/hook", "https://intranet/hook", "https://db.internal/hook", "ftp://example.com", ""]) {
      await expect(as("olivia", (q) => q("select * from public.create_webhook($1, $2)", [workspace, url]))).rejects.toThrow(/public https address/);
    }
    secret = (await as("olivia", (q) => q("select * from public.create_webhook($1, ' https://hooks.example.com/archone?team=1 ')", [workspace])))[0].secret;
    expect(secret).toMatch(/^whsec_[0-9a-f]{40}$/);
    expect(await as("olivia", (q) => q("select url, active from public.webhooks"))).toEqual([{ url: "https://hooks.example.com/archone?team=1", active: true }]);
    await expect(as("olivia", (q) => q("select secret from public.webhooks"))).rejects.toThrow(/permission denied/);
    expect(await as("edgar", (q) => q("select id from public.webhooks"))).toEqual([]);
  });

  it("are sent one signed note per saved change, whoever made it", async () => {
    await db.exec("delete from net.calls");
    const made = (await call("POST", "/objects", { name: "Notifier", typeId: "service" })).body.id;
    // A change made in the application arrives the same way: here an editor saving two rows at once.
    await as("edgar", (q) => q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'o_a', 'service', 'A'), ($1, 'o_b', 'service', 'B')", [workspace]));
    await as("edgar", (q) => q("update public.objects set deleted = true where id = 'o_b'"));
    await as("stranger", (q) => q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'theirs', 'service', 'Not ours')", [other]));
    const { rows } = await db.query<{ url: string; body: any; headers: Record<string, string> }>("select url, body, headers from net.calls order by id");
    expect(rows.map((r) => [r.body.event, r.body.resource, r.body.changed, r.body.deleted])).toEqual([
      ["model.changed", "objects", [made], []],
      ["model.changed", "objects", ["o_a", "o_b"], []],
      ["model.changed", "objects", [], ["o_b"]],
    ]);
    expect(rows[0].url).toBe("https://hooks.example.com/archone?team=1");
    expect(rows[0].body.workspaceId).toBe(workspace);
    // The receiver checks the signature over the body exactly as it was sent.
    const sent = (await db.query<{ text: string }>("select body::text as text from net.calls order by id limit 1")).rows[0].text;
    expect(rows[0].headers["X-ArchONE-Signature"]).toBe(`sha256=${createHmac("sha256", secret).update(sent).digest("hex")}`);
    expect(rows[0].headers["X-ArchONE-Event"]).toBe("model.changed");
  });

  it("report a moved box as a change to its diagram, can be tested, and stop when deleted", async () => {
    await db.exec("delete from net.calls");
    const diagram = (await call("GET", "/diagrams")).body.data[0];
    await call("PATCH", `/diagrams/${diagram.id}`, { nodes: [{ objectId: diagram.nodes[0].objectId, x: 5, y: 5 }] });
    const hook = (await as("olivia", (q) => q("select id from public.webhooks")))[0].id;
    await as("olivia", (q) => q("select public.test_webhook($1)", [hook]));
    await expect(as("edgar", (q) => q("select public.test_webhook($1)", [hook]))).rejects.toThrow(/not an owner/);
    const sent = (await db.query<{ body: any }>("select body from net.calls order by id")).rows.map((r) => `${r.body.event}:${r.body.resource ?? ""}:${(r.body.changed ?? []).join()}`);
    expect(sent).toEqual([`model.changed:diagrams:${diagram.id}`, `model.changed:diagrams:${diagram.id}`, "ping::"]);
    expect((await as("edgar", (q) => q("delete from public.webhooks returning id"))).length).toBe(0);
    expect((await as("olivia", (q) => q("delete from public.webhooks returning id"))).length).toBe(1);
    await db.exec("delete from net.calls");
    await call("POST", "/objects", { name: "Quiet", typeId: "service" });
    expect((await db.query("select count(*)::int as n from net.calls")).rows[0]).toEqual({ n: 0 });
  });
});

describe("live links", () => {
  let token = "";
  let diagram = "";
  const view = async (t: string) => (await as(null, (q) => q("select public.embed_view($1) as v", [t])))[0].v;

  it("are created by owners and editors for a diagram that exists", async () => {
    await as("edgar", async (q) => {
      await q("insert into public.objects (workspace_id, id, type_id, name, description, provenance) values ($1, 'sys', 'system', 'Shop', 'The shop', '{\"origin\":\"ai-prompt\",\"source\":\"secret prompt\"}'), ($1, 'web', 'web-app', 'Web', '', '{\"origin\":\"manual\"}'), ($1, 'api', 'service', 'API', '', '{\"origin\":\"manual\"}'), ($1, 'pay', 'external-system', 'Payments', '', '{\"origin\":\"manual\"}'), ($1, 'hidden', 'service', 'Not on the diagram', '', '{\"origin\":\"manual\"}')", [workspace]);
      await q("update public.objects set parent_id = 'sys' where id in ('web', 'api')");
      await q("insert into public.relationships (workspace_id, id, source_id, target_id, kind, label) values ($1, 'r_in', 'web', 'api', 'calls', 'inside'), ($1, 'r_out', 'api', 'pay', 'calls', 'takes payment'), ($1, 'r_other', 'hidden', 'pay', 'calls', 'elsewhere')", [workspace]);
      await q("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'ctx', 'Context', 'context')", [workspace]);
      await q("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'ctx', 'sys', 0, 0), ($1, 'ctx', 'pay', 400, 0)", [workspace]);
    });
    diagram = "ctx";
    await expect(as("vera", (q) => q("select public.create_embed($1, 'ctx')", [workspace]))).rejects.toThrow(/Only owners and editors/);
    await expect(as("edgar", (q) => q("select public.create_embed($1, 'nope')", [workspace]))).rejects.toThrow(/no longer exists/);
    token = (await as("edgar", (q) => q("select public.create_embed($1, 'ctx') as t", [workspace])))[0].t;
    expect(token).toMatch(/^[0-9a-f]{40}$/);
    expect((await as("edgar", (q) => q("select diagram_id from public.embeds"))).length).toBe(1);
    expect(await as("vera", (q) => q("select id from public.embeds"))).toEqual([]);
    await expect(as(null, (q) => q("select * from public.embeds"))).rejects.toThrow(/permission denied/);
  });

  it("show the diagram to anyone with the link, and no more than the diagram draws", async () => {
    const v = await view(token);
    expect(v).toMatchObject({ status: "ok", source: "working", diagram: { id: "ctx", name: "Context" } });
    expect(v.nodes).toHaveLength(2);
    const objects = Object.fromEntries(v.objects.map((o: any) => [o.id, o]));
    expect(Object.keys(objects).sort()).toEqual(["api", "pay", "sys", "web"]);
    // The boxes are sent in full, without the prompt they were drafted from.
    expect(objects.sys).toMatchObject({ name: "Shop", description: "The shop", provenance: { origin: "ai-prompt" } });
    // What is nested inside a box is needed to draw the rolled-up arrow, and is sent without its name.
    expect(objects.web).toMatchObject({ name: "", parent_id: "sys" });
    expect(objects.web).not.toHaveProperty("description");
    const relationships = Object.fromEntries(v.relationships.map((r: any) => [r.id, r]));
    expect(Object.keys(relationships).sort()).toEqual(["r_in", "r_out"]);
    expect(relationships.r_out).toMatchObject({ source_id: "api", target_id: "pay", label: "" });
    expect(JSON.stringify(v)).not.toMatch(/secret prompt|Not on the diagram|elsewhere|workspace_id/);
    expect(await view("0".repeat(40))).toEqual({ status: "gone" });
  });

  it("follow the model as it changes, and show the published version once review is on", async () => {
    await as("edgar", (q) => q("update public.objects set name = 'Online shop' where id = 'sys'"));
    expect((await view(token)).objects.find((o: any) => o.id === "sys").name).toBe("Online shop");
    await as("olivia", (q) => q("select public.set_review_settings($1, true, $2)", [workspace, JSON.stringify([{ id: "a", name: "Architecture", reviewerId: ids.olivia, checklist: [] }])]));
    await as("edgar", (q) => q("update public.objects set name = 'Draft name' where id = 'sys'"));
    const published = await view(token);
    expect([published.source, published.objects.find((o: any) => o.id === "sys").name]).toEqual(["published", "Online shop"]);
    // A diagram drawn after the last approval has nothing published to show yet.
    await as("edgar", (q) => q("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'new', 'New', 'custom')", [workspace]));
    const fresh = (await as("edgar", (q) => q("select public.create_embed($1, 'new') as t", [workspace])))[0].t;
    expect(await view(fresh)).toEqual({ status: "unpublished" });
    await as("olivia", (q) => q("select public.set_review_settings($1, false, '[]')", [workspace]));
    expect((await view(token)).objects.find((o: any) => o.id === "sys").name).toBe("Draft name");
  });

  it("stop working when switched off, or when their diagram is deleted", async () => {
    const second = (await as("edgar", (q) => q("select public.create_embed($1, $2) as t", [workspace, diagram])))[0].t;
    const row = (await as("edgar", (q) => q("select id from public.embeds where token = $1", [second])))[0];
    await expect(as("vera", (q) => q("select public.revoke_embed($1)", [row.id]))).rejects.toThrow(/may not switch it off/);
    await as("edgar", (q) => q("select public.revoke_embed($1)", [row.id]));
    expect(await view(second)).toEqual({ status: "gone" });
    expect((await view(token)).status).toBe("ok");
    await as("edgar", (q) => q("update public.diagrams set deleted = true where id = 'ctx'"));
    expect(await view(token)).toEqual({ status: "gone" });
  });
});

describe("processes through the API", () => {
  let area = "";
  let order = "";
  let erp = "";
  it("creates a process from a list of steps, laid out as BPMN in its lanes", async () => {
    erp = (await call("POST", "/objects", { name: "Order ERP", typeId: "application" })).body.id;
    const made = await call("POST", "/processes", {
      name: "Order to cash",
      owner: "Head of Sales",
      lanes: ["Sales", "Warehouse"],
      steps: [
        { id: "check", name: "Check the order", type: "userTask", lane: "Sales", minutes: 10 },
        { id: "ok", name: "Order complete?", type: "exclusiveGateway", lane: "Sales" },
        { id: "ship", name: "Ship the goods", type: "manualTask", lane: "Warehouse", minutes: 30 },
        { id: "ask", name: "Ask the customer", type: "sendTask", lane: "Sales" },
      ],
      flows: [
        { from: "check", to: "ok" },
        { from: "ok", to: "ship", name: "Yes", probability: 90 },
        { from: "ok", to: "ask", name: "No", probability: 10 },
      ],
      kpis: [{ name: "Cycle time", unit: "days", target: "2", better: "lower" }],
    });
    expect(made.status).toBe(201);
    order = made.body.id;
    expect(made.body).toMatchObject({ name: "Order to cash", level: 2, status: "draft", version: 0, modelled: true, steps: 3, owner: "Head of Sales" });
    expect(made.body.xml).toContain('name="Ship the goods"');
    expect(made.body.xml).toContain('<bpmn:lane id="Lane_2" name="Warehouse">');
    expect(made.body.elements.check.duration).toEqual({ min: 5, mode: 10, max: 20 });
    expect(Object.values(made.body.elements).filter((e: any) => e.probability).map((e: any) => e.probability).sort()).toEqual([10, 90]);
    expect(made.body.kpis[0]).toMatchObject({ name: "Cycle time", better: "lower" });
    // What the API stored is what the app keeps, and opens in it.
    const row = (await db.query<{ data: unknown }>("select data from public.process_models where id = $1", [order])).rows[0];
    expect(processModelSchema.safeParse(row.data).success).toBe(true);
  });

  it("keeps a landscape: areas without a model, and levels below their parent", async () => {
    const made = await call("POST", "/processes", { name: "Sell and serve", level: 0, category: "core" });
    area = made.body.id;
    expect(made.body).toMatchObject({ level: 0, modelled: false, steps: 0 });
    const child = await call("POST", "/processes", { name: "Returns", parentId: area });
    expect(child.body).toMatchObject({ level: 1, parentId: area, category: "core", modelled: false });
    expect((await call("PATCH", `/processes/${order}`, { parentId: area })).body.parentId).toBe(area);
    expect((await call("PATCH", `/processes/${area}`, { parentId: order })).body.error.message).toMatch(/inside itself/);
    expect((await call("POST", "/processes", { name: "Too high", parentId: order, level: 1 })).body.error.message).toMatch(/lower level number/);
    expect((await call("GET", "/processes?parent=none")).body.data.map((p: any) => p.name)).toEqual(["Sell and serve"]);
    await call("DELETE", `/processes/${child.body.id}`);
  });

  it("says exactly what is wrong with a process it will not take", async () => {
    expect((await call("POST", "/processes", { description: "No name" })).body.error.message).toMatch(/"name" is required/);
    expect((await call("POST", "/processes", { name: "X", steps: [{ id: "a", name: "A", type: "spaceship" }] })).body.error.message).toMatch(/type "spaceship"/);
    expect((await call("POST", "/processes", { name: "X", steps: [{ id: "a", name: "A", type: "task" }], flows: [{ from: "a", to: "zz" }] })).status).toBe(422);
    expect((await call("POST", "/processes", { name: "X", xml: "<definitions/>" })).body.error.message).toMatch(/BPMN 2.0/);
    const noDiagram = '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="p"/></definitions>';
    expect((await call("POST", "/processes", { name: "X", xml: noDiagram })).body.error.message).toMatch(/no diagram/);
    expect((await call("POST", "/processes", { name: "X", xml: `<!DOCTYPE x [<!ENTITY a "b">]>${noDiagram}` })).status).toBe(422);
    expect((await call("POST", "/processes", { name: "X", category: "fun" })).status).toBe(422);
    expect((await call("PATCH", `/processes/${order}`, { elements: { check: { raci: { Sales: "Z" } } } })).body.error.message).toMatch(/R, A, C or I/);
    expect((await call("PATCH", `/processes/${order}`, { status: "approved" })).status).toBe(422);
  });

  it("links steps to systems, finds the processes a system takes part in, and names the systems", async () => {
    const before = (await call("GET", `/processes/${order}`)).body.elements;
    const changed = await call("PATCH", `/processes/${order}`, { elements: { ...before, check: { ...before.check, objectIds: [erp], raci: { Sales: "R", "Head of Sales": "A" }, automation: "partly" } } });
    expect(changed.body.elements.check).toMatchObject({ objectIds: [erp], automation: "partly", duration: { mode: 10 } });
    expect(changed.body.objects[erp]).toEqual({ name: "Order ERP", typeId: "application" });
    expect((await call("GET", `/processes?uses=${erp}`)).body.data.map((p: any) => p.name)).toEqual(["Order to cash"]);
    expect((await call("GET", "/processes?q=cash&status=draft")).body.data).toHaveLength(1);
    const listed = (await call("GET", "/processes")).body.data.find((p: any) => p.id === order);
    expect(listed.xml).toBeUndefined();
    const model = (await call("GET", "/model")).body;
    expect(model.processes.map((p: any) => p.name).sort()).toEqual(["Order to cash", "Sell and serve"]);
    expect(model.processes[0].xml).toBeUndefined();
  });

  it("sends a process for review and publishes it as a numbered version, recorded under the key", async () => {
    expect((await call("PATCH", `/processes/${order}`, { status: "review", reviewer: "Dana", note: "Check the warehouse lane" })).body).toMatchObject({ status: "review", reviewer: "Dana", reviewNote: "Check the warehouse lane" });
    const published = (await call("PATCH", `/processes/${order}`, { status: "published", note: "First agreed version" })).body;
    expect(published).toMatchObject({ status: "published", version: 1 });
    expect(published.versions).toEqual([expect.objectContaining({ version: 1, publishedBy: "API key: write key", note: "First agreed version" })]);
    expect(published.versions[0].xml).toBeUndefined();
    const again = (await call("PATCH", `/processes/${order}`, { steps: [{ id: "a", name: "Check and ship", type: "userTask" }], status: "published", note: "Simpler" })).body;
    expect(again.version).toBe(2);
    expect(again.xml).toContain("Check and ship");
    const stored = (await db.query<{ data: any }>("select data from public.process_models where id = $1", [order])).rows[0].data;
    expect(stored.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(stored.versions[1].xml).toContain("Ship the goods");
    const audit = (await db.query<{ action: string; actor_name: string }>("select action, actor_name from public.audit_log where entity = 'process' and entity_id = $1 order by id", [order])).rows;
    expect(audit.map((a) => a.action)).toEqual(["added", "changed", "changed", "sent for review", "published version 1", "published version 2"]);
    expect(new Set(audit.map((a) => a.actor_name))).toEqual(new Set(['API key "write key"']));
  });

  it("lets only a write key without a domain limit change processes", async () => {
    expect((await call("POST", "/processes", { name: "X" }, keys.read)).body.error.code).toBe("read_only");
    expect((await call("GET", `/processes/${order}`, undefined, keys.read)).status).toBe(200);
    const propose = (await as("olivia", (q) => q("select * from public.create_api_key($1, 'assistant', 'propose')", [workspace])))[0].key;
    const refused = await call("PATCH", `/processes/${order}`, { name: "Renamed" }, propose);
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "propose_only" } } });
    expect(refused.body.error.message).toMatch(/write access/);
    const domain = (await call("POST", "/objects", { name: "Sales domain", typeId: "domain" })).body.id;
    const limited = (await as("olivia", (q) => q("select * from public.create_api_key($1, 'limited', 'write')", [workspace])))[0];
    await as("olivia", (q) => q("select public.set_api_key_domains($1, $2)", [limited.id, [domain]]));
    expect((await call("POST", "/processes", { name: "X" }, limited.key)).body.error.code).toBe("outside_limit");
    expect((await call("GET", `/processes/${order}`, undefined, keys.other)).status).toBe(404);
  });

  it("deletes a process the way the app does: what was inside moves up", async () => {
    const inner = (await call("POST", "/processes", { name: "Pick", parentId: order, level: 3 })).body.id;
    expect((await call("DELETE", `/processes/${order}`)).status).toBe(204);
    expect((await call("GET", `/processes/${order}`)).status).toBe(404);
    expect((await call("GET", `/processes/${inner}`)).body.parentId).toBe(area);
  });
});
