import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { blankBpmn } from "../bpm/bpmn";

/** Processes (PGlite): members read them, editors change them, the audit log says what happened. */

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
const process = (id: string, patch: Record<string, unknown> = {}) => ({ id, name: "Order to cash", status: "draft", version: 0, xml: blankBpmn("Order to cash"), updatedAt: new Date().toISOString(), ...patch });
const write = (who: string, data: Record<string, unknown>, deleted = false, workspace = ws) =>
  as(who, (q) => q("insert into public.process_models (workspace_id, id, data, deleted) values ($1, $2, $3, $4) on conflict (workspace_id, id) do update set data = excluded.data, deleted = excluded.deleted", [workspace, data.id, JSON.stringify(data), deleted]));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "vera", "stranger"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Bank') as id")))[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, ids.edgar, ids.vera]);
}, 60_000);

describe("process models", () => {
  it("lets editors add and change processes, and every member read them", async () => {
    await write("edgar", process("proc_1"));
    await write("olivia", process("proc_1", { status: "published", version: 1 }));
    const rows = await as("vera", (q) => q("select data from public.process_models where workspace_id = $1", [ws]));
    expect(rows.map((r) => r.data.status)).toEqual(["published"]);
    await expect(write("vera", process("proc_2"))).rejects.toThrow(/row-level security/);
    expect(await as("stranger", (q) => q("select * from public.process_models"))).toEqual([]);
    // Nothing is ever removed outright from the app: a deletion is a mark.
    await expect(as("olivia", (q) => q("delete from public.process_models where id = 'proc_1'"))).rejects.toThrow(/permission denied/);
  });

  it("refuses a process without a name, with a status it does not know, or under another id", async () => {
    await expect(write("edgar", process("proc_3", { name: "" }))).rejects.toThrow(/check constraint/);
    await expect(write("edgar", process("proc_3", { status: "approved" }))).rejects.toThrow(/check constraint/);
    await expect(as("edgar", (q) => q("insert into public.process_models (workspace_id, id, data) values ($1, 'proc_4', $2)", [ws, JSON.stringify(process("proc_5"))]))).rejects.toThrow(/check constraint/);
  });

  it("writes what happened to the audit log, not the BPMN file", async () => {
    await write("edgar", process("proc_1", { status: "published", version: 1, owner: "Sales" }));
    await write("edgar", process("proc_1", { status: "published", version: 1, owner: "Sales", xml: blankBpmn("Changed") }));
    await write("edgar", process("proc_1", { status: "draft", version: 1 }), true);
    const entries = (await db.query<{ action: string; changes: Record<string, unknown> }>("select action, changes from public.audit_log where workspace_id = $1 and entity = 'process' order by id", [ws])).rows;
    expect(entries.map((e) => e.action)).toEqual(["added", "published version 1", "changed", "changed", "deleted"]);
    expect(entries[3].changes).toEqual({ model: true });
    expect(JSON.stringify(entries)).not.toContain("bpmn:definitions");
  });

  it("gives a scenario the processes of its workspace, and purges deleted ones", async () => {
    await write("edgar", process("proc_6", { name: "Procure to pay" }));
    const scenario = (await as("olivia", (q) => q("select public.create_scenario($1, 'Next year', '') as id", [ws])))[0].id;
    const copied = await as("olivia", (q) => q("select id from public.process_models where workspace_id = $1 and not deleted order by id", [scenario]));
    expect(copied.map((r) => r.id)).toEqual(["proc_6"]);
    await as("olivia", (q) => q("select public.purge_deleted($1, interval '0 seconds')", [ws]));
    expect((await db.query("select id from public.process_models where workspace_id = $1 order by id", [ws])).rows).toEqual([{ id: "proc_6" }]);
  });
});
