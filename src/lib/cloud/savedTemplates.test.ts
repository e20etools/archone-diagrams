import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { applyTemplate, TEMPLATES, templateFromDiagram } from "../templates";
import { emptyWorkspace } from "../model";
import { fromRow, toRow } from "./rows";

/** A workspace's own templates in the database (PGlite): editors save them, every member sees them, scenarios leave them out. */

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
const made = (() => {
  const { ws: model, diagramId } = applyTemplate(emptyWorkspace("Edgar"), TEMPLATES[0].id)!;
  return templateFromDiagram(model, diagramId, { name: "Our shop", perspective: "business", about: "" }, "Edgar")!.template;
})();
const insert = (who: string, id = made.id, workspace = ws) => {
  const row = toRow("templates", workspace, id, { ...made, id });
  return as(who, (q) => q("insert into public.diagram_templates (workspace_id, id, data, created_at) values ($1, $2, $3, $4)", [row.workspace_id, row.id, JSON.stringify(row.data), row.created_at]));
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "vera", "stranger"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who[0].toUpperCase() + who.slice(1) }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Shop') as id")))[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, ids.edgar, ids.vera]);
}, 60_000);

describe("a workspace's own templates in the database", () => {
  it("are saved by editors and read by every member, and come back as they went in", async () => {
    await insert("edgar");
    await expect(insert("vera", "tpl_viewer")).rejects.toThrow(/row-level security/);
    for (const who of ["olivia", "edgar", "vera"]) {
      const rows = await as(who, (q) => q("select * from public.diagram_templates where workspace_id = $1", [ws]));
      expect(rows).toHaveLength(1);
      expect(fromRow("templates", rows[0] as any)).toEqual({ key: made.id, value: made });
    }
    expect(await as("stranger", (q) => q("select id from public.diagram_templates"))).toEqual([]);
    await as("vera", (q) => q("update public.diagram_templates set deleted = true where workspace_id = $1", [ws]));
    expect((await db.query("select 1 from public.diagram_templates where not deleted")).rows).toHaveLength(1);
    await expect(db.query("insert into public.diagram_templates (workspace_id, id, data) values ($1, 'x', '{\"id\":\"x\",\"objects\":[]}')", [ws])).rejects.toThrow(/check constraint/);
  });

  it("are written down in the audit log, and stay out of scenarios", async () => {
    await as("edgar", (q) => q("update public.diagram_templates set data = jsonb_set(data, '{name}', '\"Renamed\"') where workspace_id = $1", [ws]));
    await as("edgar", (q) => q("update public.diagram_templates set deleted = true where workspace_id = $1", [ws]));
    const log = (await db.query<{ action: string }>("select action from public.audit_log where entity = 'template' order by id")).rows.map((r) => r.action);
    expect(log).toEqual(["created", "updated", "deleted"]);
    await insert("edgar", "tpl_two");
    const scenario = (await as("edgar", (q) => q("select public.create_scenario($1, 'Target', '') as id", [ws])))[0].id as string;
    expect((await db.query("select 1 from public.diagram_templates where workspace_id = $1", [scenario])).rows).toHaveLength(0);
  });

  it("are cleared away once marked deleted for a while", async () => {
    await db.exec("alter table public.diagram_templates disable trigger stamp_change");
    await db.query("update public.diagram_templates set changed_at = now() - interval '40 days' where deleted");
    await db.exec("alter table public.diagram_templates enable trigger stamp_change");
    expect((await as("olivia", (q) => q("select public.purge_deleted($1) as n", [ws])))[0].n).toBe(1);
  });
});
