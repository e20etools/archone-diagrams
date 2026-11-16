import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { snapshotToTables } from "./cloud/collab";
import { fromRow, type Row } from "./cloud/rows";
import { emptyTables, type Tables } from "./cloud/tables";
import { redactForTrust, trustFacts } from "./trust";

/** The public trust page, on a real Postgres (PGlite): what leaves the workspace, who may switch it on, and that the app and the database make the same cut. */

const dir = (path: string) => fileURLToPath(new URL(`../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let ws = "";
let token = "";

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string | null, run: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [who ? JSON.stringify({ sub: ids[who], email: `${who}@example.com` }) : ""]);
    await tx.exec(who ? "set local role authenticated" : "set local role anon");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}
const view = async (t = token) => (await as(null, (q) => q("select public.trust_view($1) as v", [t])))[0].v as Record<string, any>;
const save = (who: string, enabled: boolean, title: string, diagram: string | null, intro = "", contact = "") =>
  as(who, async (q) => (await q("select public.set_trust_page($1, $2, $3, $4, $5, $6) as v", [ws, enabled, title, intro, contact, diagram]))[0].v as Record<string, any>);

/** The working model as the app holds it, read as the database owner. */
async function working(): Promise<Tables> {
  const tables = emptyTables();
  for (const [table, sql] of [["objects", "objects"], ["relationships", "relationships"], ["diagrams", "diagrams"], ["nodes", "diagram_nodes"]] as const) {
    const { rows } = await db.query<Row>(`select * from public.${sql} where workspace_id = $1`, [ws]);
    for (const row of rows) {
      const { key, value } = fromRow(table, row);
      if (value !== null) (tables[table] as Record<string, unknown>)[key] = value;
    }
  }
  return tables;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Shop') as id")))[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor')", [ws, ids.edgar]);
  await as("edgar", async (q) => {
    await q(
      `insert into public.objects (workspace_id, id, type_id, name, description, owner, tags, technology, fields) values
        ($1, 'shop', 'system', 'Web shop', 'Internal notes', 'Olivia', '{tier-1}', 'React', '{}'),
        ($1, 'api', 'service', 'Orders API', 'Secret detail', 'Edgar', '{}', 'Go', '{"Tier":"1"}'),
        ($1, 'crm', 'database', 'Customer DB', 'Holds everything', 'Edgar', '{pii}', 'Postgres', '{"Personal data":"yes","Data residency":"Saudi Arabia","Data classification":"Restricted"}'),
        ($1, 'dwh', 'database', 'Warehouse', '', '', '{}', '', '{"Personal data":"Yes","Data residency":"Germany"}'),
        ($1, 'logs', 'storage', 'Log archive', '', '', '{}', '', '{"Personal data":"true"}'),
        ($1, 'mail', 'external-system', 'Mailer Inc', 'Contract 4411', 'Procurement', '{}', '', '{"Data residency":"Ireland","Public purpose":"Sends order emails","Cost":"900"}'),
        ($1, 'pay', 'external-system', 'PayCo', '', '', '{}', '', '{}'),
        ($1, 'maps', 'external-system', 'Maps provider', '', '', '{}', '', '{"Public purpose":"Not connected to personal data"}'),
        ($1, 'wiki', 'system', 'Wiki', '', '', '{}', '', '{"Data residency":"Germany"}')`,
      [ws],
    );
    await q("update public.objects set parent_id = 'shop' where workspace_id = $1 and id = 'api'", [ws]);
    await q(
      `insert into public.relationships (workspace_id, id, source_id, target_id, kind, label, protocol, description) values
        ($1, 'r1', 'api', 'crm', 'reads_writes', 'customers', 'TLS', 'internal'),
        ($1, 'r2', 'crm', 'mail', 'flows_to', 'addresses', 'HTTPS', ''),
        ($1, 'r3', 'crm', 'dwh', 'replicates_to', 'nightly', '', ''),
        ($1, 'r4', 'pay', 'crm', 'calls', 'receipts', '', ''),
        ($1, 'r5', 'shop', 'maps', 'calls', 'tiles', '', ''),
        ($1, 'r6', 'wiki', 'shop', 'calls', 'links', '', '')`,
      [ws],
    );
    await q("insert into public.diagrams (workspace_id, id, name, description, view_type) values ($1, 'flow', 'How your data moves', 'Draft wording', 'dataflow'), ($1, 'inner', 'Internal', '', 'custom')", [ws]);
    await q("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'flow', 'shop', 0, 0), ($1, 'flow', 'crm', 300, 0), ($1, 'flow', 'mail', 600, 0), ($1, 'inner', 'wiki', 0, 0)", [ws]);
  });
}, 60_000);

describe("the public trust page", () => {
  it("is switched on by an owner only, and needs a heading", async () => {
    await expect(save("edgar", true, "Trust", null)).rejects.toThrow(/Only an owner/);
    await expect(save("olivia", true, "  ", null)).rejects.toThrow(/heading/);
    await expect(save("olivia", true, "Trust", "nope")).rejects.toThrow(/no longer exists/);
    const off = await save("olivia", false, "How we handle your data", "flow", "We keep it short.", "privacy@example.com");
    token = off.token;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await view()).toEqual({ status: "gone" });
    expect((await save("olivia", true, "How we handle your data", "flow", "We keep it short.", "privacy@example.com")).token).toBe(token);
    expect(await view("wrong")).toEqual({ status: "gone" });
    expect(await as("edgar", (q) => q("select * from public.trust_pages"))).toEqual([]);
    expect((await as("olivia", (q) => q("select title, enabled from public.trust_pages")))[0]).toEqual({ title: "How we handle your data", enabled: true });
    await expect(as("olivia", (q) => q("update public.trust_pages set enabled = false"))).rejects.toThrow(/permission denied/);
    const log = (await db.query<{ action: string; entity: string }>("select action, entity from public.audit_log where workspace_id = $1 and entity = 'trust page' order by id", [ws])).rows;
    expect(log.map((l) => l.action)).toEqual(["created", "updated"]);
  });

  it("sends what the page says and nothing else", async () => {
    const v = await view();
    expect(v).toMatchObject({ status: "ok", source: "working", title: "How we handle your data", intro: "We keep it short.", contact: "privacy@example.com" });
    const text = JSON.stringify(v);
    for (const secret of ["Internal notes", "Secret detail", "Holds everything", "Contract 4411", "Procurement", "Restricted", "Postgres", "React", "tier-1", "Cost", "TLS", "Draft wording", "Warehouse", "Log archive", "Wiki", "Maps provider", "Orders API", "Not connected", "nightly", "receipts"]) {
      expect(text, secret).not.toContain(secret);
    }
    const byId = Object.fromEntries((v.objects as Record<string, any>[]).map((o) => [o.id, o]));
    expect(Object.keys(byId).sort()).toEqual(["api", "crm", "dwh", "logs", "mail", "pay", "shop"]);
    expect(byId.crm).toMatchObject({ name: "Customer DB", fields: { "Personal data": "Yes", "Data residency": "Saudi Arabia" } });
    expect(byId.dwh).toMatchObject({ name: "", fields: { "Personal data": "Yes", "Data residency": "Germany" } });
    expect(byId.mail).toMatchObject({ name: "Mailer Inc", fields: { "Data residency": "Ireland", "Public purpose": "Sends order emails" } });
    expect(byId.pay).toMatchObject({ name: "PayCo", fields: {} });
    expect(byId.api).toMatchObject({ name: "", parent_id: "shop" });
    expect((v.relationships as Record<string, any>[]).map((r) => `${r.id}:${r.label}`).sort()).toEqual(["r1:", "r2:addresses", "r3:", "r4:"]);
  });

  it("makes the same cut in the database as in the app, and the same statements follow", async () => {
    const v = await view();
    const sent = snapshotToTables({ objects: v.objects, relationships: v.relationships, diagrams: [v.diagram], nodes: v.nodes });
    const cut = redactForTrust(await working(), "flow");
    expect(sent.objects).toEqual(cut.objects);
    expect(sent.relationships).toEqual(cut.relationships);
    expect(sent.diagrams).toEqual(cut.diagrams);
    expect(sent.nodes).toEqual(cut.nodes);
    expect(trustFacts(sent)).toEqual({
      processors: [
        { id: "mail", name: "Mailer Inc", purpose: "Sends order emails", region: "Ireland", systems: 1 },
        { id: "pay", name: "PayCo", purpose: "", region: "", systems: 1 },
      ],
      regions: [
        { region: "Germany", systems: 1 },
        { region: "Saudi Arabia", systems: 1 },
      ],
      unstated: 1,
      transfers: [
        { regions: ["Germany", "Saudi Arabia"], connections: 1 },
        { regions: ["Ireland", "Saudi Arabia"], connections: 1 },
      ],
    });
    // The whole model says the same as the cut: nothing the page states depends on what was left behind.
    expect(trustFacts(await working())).toEqual(trustFacts(sent));
  });

  it("goes on without a picture when no diagram is chosen or the diagram is deleted", async () => {
    await save("olivia", true, "How we handle your data", null);
    let v = await view();
    expect(v.diagram).toBeNull();
    expect((v.objects as Record<string, any>[]).find((o) => o.id === "crm")?.name).toBe("");
    expect(snapshotToTables({ objects: v.objects, relationships: v.relationships, diagrams: [], nodes: [] }).objects).toEqual(redactForTrust(await working(), null).objects);
    await save("olivia", true, "How we handle your data", "flow");
    await as("edgar", (q) => q("update public.diagrams set deleted = true where workspace_id = $1 and id = 'flow'", [ws]));
    v = await view();
    expect(v).toMatchObject({ status: "ok", diagram: null, nodes: [] });
    expect((v.objects as Record<string, any>[]).some((o) => o.id === "shop")).toBe(false);
  });

  it("shows the approved version while review is on", async () => {
    await as("olivia", (q) => q("select public.set_review_settings($1, true, $2)", [ws, JSON.stringify([{ id: "s1", name: "Check", reviewerId: ids.olivia, checklist: [] }])]));
    await as("edgar", (q) => q(`insert into public.objects (workspace_id, id, type_id, name, fields) values ($1, 'new', 'external-system', 'Unapproved vendor', '{}')`, [ws]));
    await as("edgar", (q) => q("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r9', 'crm', 'new', 'flows_to')", [ws]));
    const v = await view();
    expect(v.source).toBe("published");
    expect(JSON.stringify(v)).not.toContain("Unapproved vendor");
    expect(trustFacts(snapshotToTables({ objects: v.objects, relationships: v.relationships })).processors.map((p) => p.name)).toEqual(["Mailer Inc", "PayCo"]);
  });
});
