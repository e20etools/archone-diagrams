import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { OBJECT_TYPES } from "../catalog";
import { CATEGORIES, categoryRank, categoryRefusal, typeCategories, viewCategory } from "../categories";
import { createObject, createRelationship, emptyWorkspace } from "../model";
import { VIEW_TYPES } from "../types";
import { createView } from "../views";

/** Roles per category (PGlite): what each member may see and change, enforced by the database. */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let ws = "";

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string, run: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids[who], email: `${who}@example.com` })]);
    await tx.exec("set local role authenticated");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}
const denied = (who: string, sql: string, params: unknown[] = []) => as(who, (q) => q(sql, params)).then(() => "allowed", (e: Error) => (/row-level security|Only an owner|owner has every/.test(e.message) ? "denied" : e.message));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "ivan", "vera"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Bank') as id")))[0].id;
  // Ivan edits infrastructure, views applications, may not see data. Vera comments everywhere but business.
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'commenter')", [ws, ids.ivan, ids.vera]);
  for (const sql of [
    "insert into public.objects (workspace_id, id, type_id, name) values ($1, 'srv', 'server', 'Server'), ($1, 'app', 'application', 'App'), ($1, 'db', 'database', 'DB'), ($1, 'cust', 'actor', 'Customer')",
    "insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd_infra', 'Infra', 'deployment'), ($1, 'd_app', 'Apps', 'container'), ($1, 'd_data', 'Data', 'dataflow'), ($1, 'd_biz', 'Biz', 'business')",
    "insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd_data', 'db', 0, 0), ($1, 'd_app', 'app', 0, 0)",
  ])
    await db.query(sql, [ws]);
}, 60_000);

describe("roles per category", () => {
  it("the database sorts types and kinds of diagram into the same categories as the app", async () => {
    for (const t of OBJECT_TYPES) {
      const sql = (await db.query<{ c: string[] }>("select public.type_categories($1) as c", [t.id])).rows[0].c;
      expect([...sql].sort(), t.id).toEqual([...typeCategories(t.id)].sort());
    }
    for (const v of VIEW_TYPES) expect((await db.query<{ c: string }>("select public.view_category($1) as c", [v])).rows[0].c, v).toBe(viewCategory(v));
  });

  it("are set by owners only, never above the workspace role, and recorded", async () => {
    expect(await denied("ivan", "select public.set_member_category_roles($1, $2, '{\"data\":\"none\"}')", [ws, ids.ivan])).toBe("denied");
    expect(await denied("olivia", "select public.set_member_category_roles($1, $2, '{\"data\":\"none\"}')", [ws, ids.olivia])).toBe("denied");
    await expect(as("olivia", (q) => q("select public.set_member_category_roles($1, $2, '{\"data\":\"boss\"}')", [ws, ids.ivan]))).rejects.toThrow(/editor, commenter, viewer or none/);
    await as("olivia", (q) => q("select public.set_member_category_roles($1, $2, $3)", [ws, ids.ivan, { applications: "viewer", data: "none", business: "viewer", infrastructure: "editor" }]));
    await as("olivia", (q) => q("select public.set_member_category_roles($1, $2, $3)", [ws, ids.vera, { business: "none", data: "editor" }]));
    const people = await as("olivia", (q) => q("select user_id, category_roles from public.workspace_people($1)", [ws]));
    // "editor" for a commenter, and "editor" for an editor, would change nothing, so they are not kept.
    expect(people.find((p) => p.user_id === ids.ivan)!.category_roles).toEqual({ applications: "viewer", data: "none", business: "viewer" });
    expect(people.find((p) => p.user_id === ids.vera)!.category_roles).toEqual({ business: "none" });
    expect((await db.query("select 1 from public.audit_log where action = 'category roles changed'")).rows).toHaveLength(2);
  });

  it("hide the diagrams of a category with no access, with their boxes and comments, but not its objects", async () => {
    await as("olivia", (q) => q("insert into public.comments (workspace_id, diagram_id, target_kind, target_id, body) values ($1, 'd_data', 'diagram', 'd_data', 'Hidden?')", [ws]));
    const seen = (await as("ivan", (q) => q("select id from public.diagrams order by id"))).map((r) => r.id);
    expect(seen).toEqual(["d_app", "d_biz", "d_infra"]);
    expect((await as("ivan", (q) => q("select diagram_id from public.diagram_nodes"))).map((r) => r.diagram_id)).toEqual(["d_app"]);
    expect(await as("ivan", (q) => q("select 1 from public.comments"))).toHaveLength(0);
    expect((await as("ivan", (q) => q("select id from public.objects order by id"))).map((r) => r.id)).toEqual(["app", "cust", "db", "srv"]);
    expect((await as("vera", (q) => q("select id from public.diagrams order by id"))).map((r) => r.id)).toEqual(["d_app", "d_data", "d_infra"]);
  });

  it("let a member change only the diagrams and objects of the categories they edit", async () => {
    expect(await denied("ivan", "update public.objects set name = 'Big server' where workspace_id = $1 and id = 'srv'", [ws])).toBe("allowed");
    expect(await denied("ivan", "insert into public.objects (workspace_id, id, type_id, name) values ($1, 'fw', 'network', 'Firewall')", [ws])).toBe("allowed");
    expect(await denied("ivan", "insert into public.objects (workspace_id, id, type_id, name) values ($1, 'svc', 'service', 'Service')", [ws])).toBe("denied");
    expect((await as("ivan", (q) => q("update public.objects set name = 'Renamed' where workspace_id = $1 and id = 'app' returning id", [ws])))).toHaveLength(0);
    // Turning a server into an application would move it out of what Ivan edits.
    expect(await denied("ivan", "update public.objects set type_id = 'application' where workspace_id = $1 and id = 'srv'", [ws])).toBe("denied");
    expect(await denied("ivan", "insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd2', 'Infra 2', 'deployment')", [ws])).toBe("allowed");
    expect(await denied("ivan", "insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd3', 'Ctx', 'context')", [ws])).toBe("denied");
    expect(await denied("ivan", "update public.diagrams set view_type = 'landscape' where workspace_id = $1 and id = 'd2'", [ws])).toBe("denied");
    expect(await denied("ivan", "insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd_infra', 'srv', 1, 1)", [ws])).toBe("allowed");
    expect(await denied("ivan", "insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd_app', 'srv', 1, 1)", [ws])).toBe("denied");
    // A relationship needs one end Ivan edits.
    expect(await denied("ivan", "insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r1', 'app', 'srv', 'hosted_on')", [ws])).toBe("allowed");
    expect(await denied("ivan", "insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r2', 'app', 'db', 'reads_writes')", [ws])).toBe("denied");
  });

  it("let a member comment only where the category allows it", async () => {
    expect(await denied("vera", "insert into public.comments (workspace_id, diagram_id, target_kind, target_id, body) values ($1, 'd_app', 'diagram', 'd_app', 'Fine')", [ws])).toBe("allowed");
    expect(await denied("ivan", "insert into public.comments (workspace_id, diagram_id, target_kind, target_id, body) values ($1, 'd_app', 'diagram', 'd_app', 'No')", [ws])).toBe("denied");
  });

  it("leave hidden diagrams out of versions, and carry over to scenarios", async () => {
    const version = (await as("olivia", (q) => q("select public.save_version($1, 'V1', '') as id", [ws])))[0].id;
    expect(await denied("ivan", "select snapshot from public.versions")).toMatch(/permission denied/);
    const snap = (await as("ivan", (q) => q("select public.version_snapshot($1, $2) as s", [ws, version])))[0].s;
    expect(snap.diagrams.map((d: { id: string }) => d.id).sort()).toEqual(["d2", "d_app", "d_biz", "d_infra"]);
    expect(snap.nodes.every((n: { diagram_id: string }) => n.diagram_id !== "d_data")).toBe(true);
    expect(snap.objects.length).toBeGreaterThan(3);
    const scenario = (await as("ivan", (q) => q("select public.create_scenario($1, 'Move', '') as id", [ws])))[0].id;
    expect((await db.query<{ r: object }>("select category_roles as r from public.workspace_members where workspace_id = $1 and user_id = $2", [scenario, ids.ivan])).rows[0].r).toEqual({ applications: "viewer", data: "none", business: "viewer" });
  });

  it("are cleared when a member becomes an owner", async () => {
    await db.query("update public.workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2", [ws, ids.vera]);
    expect((await db.query<{ r: object }>("select category_roles as r from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, ids.vera])).rows[0].r).toEqual({});
  });
});

describe("roles per category in the app", () => {
  it("narrow the workspace role and never widen it", () => {
    expect(categoryRank("viewer", { data: "editor" }, "data")).toBe(1);
    expect(categoryRank("editor", { data: "none" }, "data")).toBe(0);
    expect(categoryRank("editor", {}, "data")).toBe(3);
    expect(categoryRank("owner", { data: "none" }, "data")).toBe(4);
    expect(categoryRank(null, { data: "none" }, "data")).toBe(4);
    expect(CATEGORIES).toHaveLength(5);
  });

  it("refuse an edit outside the categories edited, before it is sent", () => {
    let model = emptyWorkspace("Ivan");
    const server = createObject(model, { typeId: "server", name: "Server" });
    const app = createObject(server.ws, { typeId: "application", name: "App" });
    model = app.ws;
    const roles = { applications: "viewer" as const };
    const infra = createView(model, { name: "Infra", viewType: "deployment" });
    expect(categoryRefusal(model, infra.ws, "editor", roles)).toBeNull();
    expect(categoryRefusal(model, createView(model, { name: "Ctx", viewType: "landscape" }).ws, "editor", roles)).toMatch(/Applications/);
    expect(categoryRefusal(model, createObject(model, { typeId: "service", name: "S" }).ws, "editor", roles)).toMatch(/Applications/);
    expect(categoryRefusal(model, createRelationship(model, { sourceId: app.object.id, targetId: server.object.id, kind: "hosted_on" }).ws, "editor", roles)).toBeNull();
    expect(categoryRefusal(model, createObject(model, { typeId: "service", name: "S" }).ws, "editor", {})).toBeNull();
  });
});
