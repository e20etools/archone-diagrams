import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/** The file library's rules (PGlite): who sees, uploads, links and deletes a file. */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let ws = "";
let other = "";

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string, run: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids[who], email: `${who}@example.com` })]);
    await tx.exec("set local role authenticated");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}
const attempt = (who: string, sql: string, params: unknown[] = []) =>
  as(who, (q) => q(sql, params)).then(
    (rows) => (rows.length ? "allowed" : "nothing"),
    (e: Error) => (/row-level security|permission denied/.test(e.message) ? "denied" : e.message),
  );
const seen = async (who: string) => (await as(who, (q) => q("select name from public.diagram_files order by name"))).map((r) => r.name);

async function upload(who: string, name: string, workspace = ws): Promise<string> {
  const id = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
  await as(who, (q) => q("insert into public.diagram_files (id, workspace_id, name, size, storage_path) values ($1::uuid, $2::uuid, $3::text, 10, $2::text || '/' || $1::text || '/' || $3::text)", [id, workspace, name]));
  return id;
}
const link = (who: string, file: string, diagram: string) => attempt(who, "insert into public.diagram_file_links (workspace_id, file_id, diagram_id) values ($1, $2, $3) returning file_id", [ws, file, diagram]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "ivan", "vera", "stranger"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Bank') as id")))[0].id;
  other = (await as("stranger", (q) => q("select public.create_workspace('Elsewhere') as id")))[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'editor'), ($1, $4, 'viewer')", [ws, ids.edgar, ids.ivan, ids.vera]);
  await db.query("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd_app', 'Apps', 'container'), ($1, 'd_data', 'Data', 'dataflow'), ($1, 'd_infra', 'Network', 'deployment')", [ws]);
  // Ivan may not see data diagrams; Vera views everything.
  await as("olivia", (q) => q("select public.set_member_category_roles($1, $2, $3)", [ws, ids.ivan, { data: "none" }]));
}, 60_000);

describe("the file library", () => {
  let vendor = "";
  let design = "";

  it("lets editors upload, and nobody else; a file is kept under its workspace and its own id", async () => {
    vendor = await upload("edgar", "Vendor guide.pdf");
    design = await upload("ivan", "Network design.vsdx");
    expect(await attempt("vera", "insert into public.diagram_files (workspace_id, name, size, storage_path) values ($1::uuid, 'x', 1, $1::text || '/x/x') returning id", [ws])).toBe("denied");
    expect(await attempt("stranger", "insert into public.diagram_files (workspace_id, name, size, storage_path) values ($1::uuid, 'x', 1, $1::text || '/x/x') returning id", [ws])).toBe("denied");
    // Someone else's name as the uploader is refused.
    const id = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
    expect(await attempt("edgar", "insert into public.diagram_files (id, workspace_id, name, size, storage_path, uploaded_by) values ($1::uuid, $2::uuid, 'x', 1, $2::text || '/' || $1::text || '/x', $3) returning id", [id, ws, ids.ivan])).toBe("denied");
    // The path must be the workspace and the file's own id.
    await expect(as("edgar", (q) => q("insert into public.diagram_files (workspace_id, name, size, storage_path) values ($1, 'x', 1, $2)", [ws, `${other}/x/x`]))).rejects.toThrow(/check constraint/);
    await expect(as("edgar", (q) => q("insert into public.diagram_files (id, workspace_id, name, size, storage_path) values ($1::uuid, $2::uuid, 'big', 52428801, $2::text || '/' || $1::text || '/big')", [id, ws]))).rejects.toThrow(/check constraint/);
  });

  it("shows a file only to its uploader until it is linked to a diagram", async () => {
    expect(await seen("edgar")).toEqual(["Vendor guide.pdf"]);
    expect(await seen("ivan")).toEqual(["Network design.vsdx"]);
    expect(await seen("vera")).toEqual([]);
    // An owner sees every diagram, but not files nobody has linked to one.
    expect(await seen("olivia")).toEqual([]);
    expect(await seen("stranger")).toEqual([]);
  });

  it("links a file to diagrams its uploader can edit, and then those who can see the diagram see the file", async () => {
    expect(await link("edgar", vendor, "d_data")).toBe("allowed");
    expect(await link("edgar", vendor, "d_app")).toBe("allowed");
    expect(await seen("vera")).toEqual(["Vendor guide.pdf"]);
    expect(await seen("olivia")).toEqual(["Vendor guide.pdf"]);
    expect(await seen("ivan")).toEqual(["Network design.vsdx", "Vendor guide.pdf"]);
    // Ivan sees the link to the diagram he can see, not the one to data.
    expect((await as("ivan", (q) => q("select diagram_id from public.diagram_file_links where file_id = $1", [vendor]))).map((r) => r.diagram_id)).toEqual(["d_app"]);
    // A file you did not upload is not yours to link, even to a diagram you can edit; nor can a viewer link.
    expect(await link("ivan", vendor, "d_infra")).toBe("denied");
    expect(await link("vera", vendor, "d_infra")).toBe("denied");
    // Ivan cannot link his file to a diagram he may not see.
    expect(await link("ivan", design, "d_data")).toBe("denied");
    expect(await link("ivan", design, "d_infra")).toBe("allowed");
    // The owner may link any file they can see.
    expect(await link("olivia", vendor, "d_infra")).toBe("allowed");
  });

  it("hides a file again when the diagrams it is linked to are deleted or out of reach", async () => {
    await db.query("update public.diagrams set deleted = true where workspace_id = $1 and id = 'd_infra'", [ws]);
    expect(await seen("vera")).toEqual(["Vendor guide.pdf"]);
    expect(await seen("ivan")).toEqual(["Network design.vsdx", "Vendor guide.pdf"]);
    expect(await seen("edgar")).toEqual(["Vendor guide.pdf"]);
    await db.query("update public.diagrams set deleted = false where workspace_id = $1 and id = 'd_infra'", [ws]);
    expect(await seen("edgar")).toEqual(["Network design.vsdx", "Vendor guide.pdf"]);
  });

  it("lets the uploader and owners rename, unlink and delete; others not", async () => {
    expect(await attempt("ivan", "update public.diagram_files set name = 'Mine now' where id = $1 returning id", [vendor])).toBe("nothing");
    expect(await attempt("edgar", "update public.diagram_files set description = 'Install guide, v3' where id = $1 returning id", [vendor])).toBe("allowed");
    expect(await attempt("olivia", "update public.diagram_files set kind = 'vendor' where id = $1 returning id", [vendor])).toBe("allowed");
    // Where a file is kept, and who sent it, never change.
    expect(await attempt("edgar", "update public.diagram_files set storage_path = 'elsewhere' where id = $1 returning id", [vendor])).toBe("denied");
    expect(await attempt("edgar", "update public.diagram_files set uploaded_by = $2 where id = $1 returning id", [vendor, ids.ivan])).toBe("denied");
    expect(await attempt("vera", "delete from public.diagram_file_links where file_id = $1 returning file_id", [vendor])).toBe("nothing");
    expect(await attempt("edgar", "delete from public.diagram_file_links where file_id = $1 and diagram_id = 'd_data' returning file_id", [vendor])).toBe("allowed");
    expect(await attempt("ivan", "delete from public.diagram_files where id = $1 returning id", [vendor])).toBe("nothing");
    expect(await attempt("olivia", "delete from public.diagram_files where id = $1 returning id", [design])).toBe("allowed");
    expect(await seen("ivan")).toEqual(["Vendor guide.pdf"]);
  });

  it("forgets a file's links when its diagram goes, and a former member sees nothing", async () => {
    await db.query("delete from public.diagrams where workspace_id = $1 and id = 'd_app'", [ws]);
    expect((await db.query("select diagram_id from public.diagram_file_links where file_id = $1 order by 1", [vendor])).rows.map((r: any) => r.diagram_id)).toEqual(["d_infra"]);
    await db.query("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, ids.edgar]);
    expect(await seen("edgar")).toEqual([]);
  });

  it("writes uploads, links and deletions to the audit log", async () => {
    const log = (await db.query<{ entity: string; action: string; entity_name: string }>("select entity, action, entity_name from public.audit_log where workspace_id = $1 and entity = 'file' order by id", [ws])).rows;
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(["created", "linked to Data", "unlinked from Data", "updated", "deleted"]));
    expect(log.find((e) => e.action === "deleted")?.entity_name).toBe("Network design.vsdx");
  });
});
