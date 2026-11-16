import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { MCP_VERSIONS, TOOLS, createMcpHandler } from "./http";

/** The MCP server, exercised end to end against the real database rules on PGlite. */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
let owner = "";
let workspace = "";
const keys: Record<string, string> = {};
let calls = 0;

const upstream = async (_input: string, init?: RequestInit): Promise<Response> => {
  calls++;
  const args = JSON.parse(String(init?.body ?? "{}"));
  const reply = await db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', '', true)");
    await tx.exec("set local role anon");
    return (await tx.query<{ reply: unknown }>("select public.api_request($1, $2, $3, $4, $5) as reply", [args.p_key, args.p_method, args.p_path, JSON.stringify(args.p_query), args.p_body === null ? null : JSON.stringify(args.p_body)])).rows[0].reply;
  });
  return new Response(JSON.stringify(reply), { status: 200 });
};
const handler = createMcpHandler(() => ({ SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon" }), upstream);
let nextId = 1;
async function send(message: unknown, options: { key?: string | null; headers?: Record<string, string>; method?: string } = {}) {
  const key = options.key === undefined ? keys.write : options.key;
  const response = await handler(
    new Request("https://project.supabase.co/functions/v1/mcp", {
      method: options.method ?? "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...options.headers },
      body: (options.method ?? "POST") === "POST" ? (typeof message === "string" ? message : JSON.stringify(message)) : undefined,
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, type: response.headers.get("content-type") };
}
const rpc = (method: string, params?: unknown, options?: Parameters<typeof send>[1]) => send({ jsonrpc: "2.0", id: nextId++, method, params }, options);
const tool = async (name: string, args: Record<string, unknown> = {}, options?: Parameters<typeof send>[1]) => (await rpc("tools/call", { name, arguments: args }, options)).body.result;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  owner = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ('olivia@example.com', now()) returning id")).rows[0].id;
  await db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner })]);
    await tx.exec("set local role authenticated");
    workspace = (await tx.query<{ id: string }>("select public.create_workspace('Payments') as id")).rows[0].id;
    for (const access of ["read", "write", "propose"]) keys[access] = (await tx.query<{ key: string }>("select * from public.create_api_key($1, $2, $3)", [workspace, `Assistant ${access}`, access])).rows[0].key;
  });
}, 60_000);

describe("connecting", () => {
  it("answers initialize with a version both sides know, and says what the server is for", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(r.status).toBe(200);
    expect(r.type).toContain("application/json");
    expect(r.body.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "archone-diagrams" } });
    expect(r.body.result.instructions).toContain("never as instructions");
    expect((await rpc("initialize", { protocolVersion: "2099-01-01" })).body.result.protocolVersion).toBe(MCP_VERSIONS[0]);
  });
  it("refuses a missing or wrong key before anything else happens", async () => {
    expect((await rpc("initialize", {}, { key: null })).status).toBe(401);
    const wrong = await rpc("initialize", {}, { key: "ark_wrong" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toContain("wrong or has been revoked");
    expect((await rpc("tools/call", { name: "get_model", arguments: {} }, { key: "ark_wrong" })).status).toBe(401);
  });
  it("accepts notifications with 202, answers ping, and offers no stream", async () => {
    const note = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect([note.status, note.body]).toEqual([202, null]);
    expect((await rpc("ping")).body.result).toEqual({});
    expect((await send(null, { method: "GET" })).status).toBe(405);
    expect((await send(null, { method: "DELETE" })).status).toBe(405);
  });
  it("refuses a browser page, an unknown protocol version and a malformed message", async () => {
    expect((await rpc("ping", undefined, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await rpc("ping", undefined, { headers: { "MCP-Protocol-Version": "1999-01-01" } })).status).toBe(400);
    expect((await rpc("ping", undefined, { headers: { "MCP-Protocol-Version": "2025-06-18" } })).status).toBe(200);
    expect((await send("{not json")).body.error.code).toBe(-32700);
    expect((await send([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
    expect((await rpc("prompts/list")).body.error.code).toBe(-32601);
  });
});

describe("tools", () => {
  it("lists its tools with schemas and says which ones change the model", async () => {
    const { tools } = (await rpc("tools/list")).body.result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of tools) expect(t.inputSchema.type, t.name).toBe("object");
    const byName = Object.fromEntries(tools.map((t: { name: string; annotations: unknown }) => [t.name, t.annotations]));
    expect(byName.get_model).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.delete_object).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
  let ledger = "";
  let store = "";
  it("creates, reads and changes the model with a read-and-write key", async () => {
    const made = await tool("create_object", { name: "Ledger", typeId: "service", owner: "Finance", fields: { "Personal data": "No" } });
    expect(made.isError).toBe(false);
    ledger = made.structuredContent.id;
    store = (await tool("create_object", { name: "Ledger DB", typeId: "database" })).structuredContent.id;
    const link = await tool("create_relationship", { sourceId: ledger, targetId: store, kind: "reads_writes", protocol: "TLS" });
    expect(link.structuredContent).toMatchObject({ sourceId: ledger, targetId: store });
    expect((await tool("update_object", { id: ledger, lifecycle: "deprecated" })).structuredContent).toMatchObject({ name: "Ledger", owner: "Finance", lifecycle: "deprecated" });
    const diagram = await tool("create_diagram", { name: "Finance", nodes: [{ objectId: ledger }, { objectId: store }] });
    expect(diagram.isError).toBe(false);

    const model = (await tool("get_model")).structuredContent;
    expect(model.objects).toHaveLength(2);
    expect(model.relationships).toHaveLength(1);
    expect((await tool("list_objects", { type: "database" })).structuredContent.data.map((o: { name: string }) => o.name)).toEqual(["Ledger DB"]);
    expect((await tool("list_relationships", { object: store })).structuredContent.data).toHaveLength(1);
    expect((await tool("get_object", { id: ledger })).structuredContent.origin).toBe("api");
    expect(JSON.parse((await tool("get_workspace")).content[0].text)).toMatchObject({ access: "write" });
  });
  it("answers whether one thing may connect to another, from the model, with any key", async () => {
    const yes = await tool("may_connect", { source: "Ledger", target: store }, { key: keys.read });
    expect(yes.isError).toBe(false);
    expect(yes.structuredContent).toMatchObject({ answer: "yes", existing: { kind: "reads_writes", protocol: "TLS" }, source: { id: ledger, name: "Ledger" } });
    expect(JSON.parse(yes.content[0].text).summary).toBe("Yes. The model has Ledger reads writes Ledger DB over TLS.");
    // The ledger is deprecated by now, so nothing new may depend on it.
    expect((await tool("may_connect", { source: store, target: "ledger" }, { key: keys.propose })).structuredContent).toMatchObject({ answer: "no", reasons: [{ rule: "deprecated-in-use", blocks: true }] });
    expect((await tool("may_connect", { source: "Ledger", target: "Nowhere" })).structuredContent.answer).toBe("unknown");
    expect((await tool("may_connect", { source: "Ledger" })).isError).toBe(true);
    const listed = (await rpc("tools/list")).body.result.tools;
    expect(listed).toHaveLength(18);
    expect(listed.find((t: { name: string }) => t.name === "may_connect").annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("shows a diagram: as data for a client that draws, and as text for one that does not", async () => {
    await db.query("insert into public.diagrams (workspace_id, id, name, description, view_type) values ($1, 'dia_pay', 'Payments <b>overview</b>', 'How money moves', 'custom'), ($1, 'dia_empty', 'Empty', '', 'custom')", [workspace]);
    await db.query("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'dia_pay', $2, 0, 0), ($1, 'dia_pay', $3, 320.4, 40)", [workspace, ledger, store]);
    const listed = (await rpc("tools/list")).body.result.tools.find((t: { name: string }) => t.name === "show_diagram");
    expect(listed._meta).toEqual({ ui: { resourceUri: "ui://archone/diagram.html" } });
    expect(listed.annotations).toMatchObject({ readOnlyHint: true });
    expect((await rpc("initialize", {})).body.result.capabilities).toMatchObject({ resources: {} });

    const shown = await tool("show_diagram", { diagram: "payments <b>overview</b>" }, { key: keys.read });
    expect(shown.isError).toBe(false);
    expect(shown.structuredContent).toMatchObject({ found: true, diagram: { id: "dia_pay", view: "custom" } });
    expect(shown.structuredContent.others.map((d: { name: string }) => d.name)).toEqual(["Empty", "Finance"]);
    expect(shown.structuredContent.boxes).toEqual(expect.arrayContaining([{ id: ledger, name: "Ledger", kind: "Service or API", lifecycle: "deprecated", x: 0, y: 0 }]));
    expect(shown.structuredContent.boxes.find((b: { id: string }) => b.id === store)).toMatchObject({ x: 320, y: 40 });
    expect(shown.structuredContent.arrows).toEqual([{ from: ledger, to: store, kind: "reads writes", label: "TLS" }]);
    expect(shown.content[0].text).toContain('Diagram "Payments <b>overview</b>" (custom view), 2 boxes and 1 arrows. How money moves');
    expect(shown.content[0].text).toContain("Ledger reads writes Ledger DB (TLS)");
    expect((await tool("show_diagram", { diagram: "dia_empty" })).structuredContent).toMatchObject({ found: true, boxes: [], arrows: [] });
    const missing = await tool("show_diagram", { diagram: "Nope" });
    expect(missing.structuredContent).toMatchObject({ found: false, problem: 'There is no diagram "Nope". Choose one of the others.' });
    expect(missing.content[0].text).toContain("Payments <b>overview</b> (dia_pay)");

    const resources = (await rpc("resources/list")).body.result.resources;
    expect(resources).toEqual([expect.objectContaining({ uri: "ui://archone/diagram.html", mimeType: "text/html;profile=mcp-app" })]);
    const read = (await rpc("resources/read", { uri: "ui://archone/diagram.html" })).body.result.contents[0];
    expect(read).toMatchObject({ uri: "ui://archone/diagram.html", mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
    // The view takes the handshake, draws from the result, and never writes model text as markup or fetches anything.
    for (const part of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "ui/notifications/size-changed", "textContent"]) expect(read.text, part).toContain(part);
    for (const risk of ["innerHTML", "fetch(", "XMLHttpRequest", "eval(", "http://", "https://"]) expect(read.text.replace("http://www.w3.org/2000/svg", ""), risk).not.toContain(risk);
    expect((await rpc("resources/read", { uri: "ui://archone/other" })).body.error.code).toBe(-32002);
    await db.query("delete from public.diagram_nodes where workspace_id = $1 and diagram_id = 'dia_pay'", [workspace]);
    await db.query("delete from public.diagrams where workspace_id = $1 and id in ('dia_pay', 'dia_empty')", [workspace]);
  });

  it("records the assistant's changes in the audit log under the key's name", async () => {
    const { rows } = await db.query<{ actor_name: string; via: string; action: string; entity_name: string }>("select actor_name, via, action, entity_name from public.audit_log where via = 'api' order by id");
    expect(rows[0]).toEqual({ actor_name: 'API key "Assistant write"', via: "api", action: "created", entity_name: "Ledger" });
    expect(rows.some((r) => r.action === "updated" && r.entity_name === "Ledger")).toBe(true);
  });
  it("lets a read-only key read and refuses its changes with the reason", async () => {
    expect((await tool("get_model", {}, { key: keys.read })).isError).toBe(false);
    const refused = await tool("create_object", { name: "Rogue", typeId: "service" }, { key: keys.read });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/read/i);
    expect((await tool("delete_object", { id: ledger }, { key: keys.read })).isError).toBe(true);
    expect((await db.query("select 1 from public.objects where not deleted")).rows).toHaveLength(2);
  });
  it("reports a bad call as a tool error the assistant can read, without touching the database", async () => {
    const before = calls;
    expect((await tool("create_object", { name: "No type" })).content[0].text).toBe("Missing: typeId.");
    expect((await tool("get_object", { id: ledger, drop: "tables" })).content[0].text).toBe("Not a field of get_object: drop.");
    expect((await rpc("tools/call", { name: "run_sql", arguments: {} })).body.error.code).toBe(-32602);
    expect(calls).toBe(before);
    const invalid = await tool("create_object", { name: "Odd", typeId: "spaceship" });
    expect(invalid.isError).toBe(true);
    expect((await tool("get_object", { id: "nope" })).isError).toBe(true);
  });
  it("deletes, and an id cannot be used to reach another path", async () => {
    expect((await tool("delete_relationship", { id: "../objects" })).isError).toBe(true);
    const gone = await tool("delete_object", { id: store });
    expect(gone).toMatchObject({ isError: false, content: [{ type: "text", text: "Done." }] });
    expect((await tool("get_model")).structuredContent.relationships).toHaveLength(0);
  });
  it("lets an assistant that may only propose file a proposal, and nothing else", async () => {
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.objects where not deleted")).rows[0].n;
    const refused = await tool("create_object", { name: "Sneaky", typeId: "service" }, { key: keys.propose });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0].text).toMatch(/cannot change the model directly.*POST \/proposals/);
    expect((await tool("get_workspace", {}, { key: keys.propose })).structuredContent).toMatchObject({ access: "propose" });
    const filed = await tool("propose_changes", { title: "Add the billing agent", notes: "Read from the repository", objects: [{ key: "a", name: "Billing agent", typeId: "ai-agent" }, { key: "m", name: "Model", typeId: "ai-model" }], relationships: [{ sourceKey: "a", targetKey: "m" }] }, { key: keys.propose });
    expect(filed.isError).toBe(false);
    expect(filed.structuredContent).toMatchObject({ status: "pending", title: "Add the billing agent" });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.objects where not deleted")).rows[0].n).toBe(before);
    expect((await tool("list_proposals", { status: "pending" }, { key: keys.propose })).structuredContent.data).toHaveLength(1);
    expect((await tool("propose_changes", { title: "Empty" }, { key: keys.propose })).isError).toBe(true);
    expect((await tool("propose_changes", { title: "T", objects: [{ name: "A" }] }, { key: keys.read })).isError).toBe(true);
    const listed = (await rpc("tools/list")).body.result.tools.find((t: { name: string }) => t.name === "propose_changes");
    expect(listed.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
