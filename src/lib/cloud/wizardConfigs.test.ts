import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { emptyWorkspace } from "../model";
import { BUILT_IN_STEPS, saveWizard } from "../wizard";
import { fromRow, toRow } from "./rows";

/** The wizard's questions in the database (PGlite): owners set them, members read them, scenarios take them along. */

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
const config = saveWizard(emptyWorkspace("Olivia"), "container", [...BUILT_IN_STEPS.container, { id: "monitoring", title: "Monitoring", question: "What watches it?", kinds: ["service"], usual: "applications.back-end-service", placeholder: "", links: [] }], "Olivia").wizards.container;
const insert = (who: string) => {
  const row = toRow("wizards", ws, config.id, config);
  return as(who, (q) => q("insert into public.wizard_configs (workspace_id, id, data, created_at) values ($1, $2, $3, $4)", [row.workspace_id, row.id, JSON.stringify(row.data), row.created_at]));
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Shop') as id")))[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor')", [ws, ids.edgar]);
}, 60_000);

describe("the wizard's questions in the database", () => {
  it("are set by owners only, read by every member, and come back as they went in", async () => {
    await expect(insert("edgar")).rejects.toThrow(/row-level security/);
    await insert("olivia");
    const rows = await as("edgar", (q) => q("select * from public.wizard_configs where workspace_id = $1", [ws]));
    expect(fromRow("wizards", rows[0] as any)).toEqual({ key: "container", value: config });
    await expect(db.query("insert into public.wizard_configs (workspace_id, id, data) values ($1, 'nonsense', '{\"id\":\"nonsense\",\"steps\":[{}]}')", [ws])).rejects.toThrow(/check constraint/);
    expect((await db.query<{ action: string }>("select action from public.audit_log where entity = 'wizard'")).rows.map((r) => r.action)).toEqual(["created"]);
  });

  it("go with the workspace into a scenario", async () => {
    const scenario = (await as("edgar", (q) => q("select public.create_scenario($1, 'Target', '') as id", [ws])))[0].id as string;
    const copied = (await db.query<{ n: number }>("select jsonb_array_length(data -> 'steps') as n from public.wizard_configs where workspace_id = $1 and id = 'container'", [scenario])).rows;
    expect(copied).toEqual([{ n: BUILT_IN_STEPS.container.length + 1 }]);
  });
});
