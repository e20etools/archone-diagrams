import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { emptySelector } from "../checks/custom";
import type { CustomRule } from "../types";
import { fromRow, toRow } from "./rows";

/** The workspace's own rules in the database (PGlite): owners write them, members read them, a scenario takes them along. */

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
const rule = (id: string, title: string, enabled = true): CustomRule => ({
  id, title, text: "Every database must have an owner", severity: "high", enabled,
  check: { kind: "object", subject: { ...emptySelector(), types: ["database"] }, require: "owner", value: "" },
  author: "Olivia", createdAt: "2026-11-16T09:00:00.000Z", updatedAt: "2026-11-16T09:00:00.000Z",
});
const insert = (who: string, r: CustomRule, workspace = ws) => {
  const row = toRow("rules", workspace, r.id, r);
  return as(who, (q) => q("insert into public.custom_rules (workspace_id, id, data, created_at) values ($1, $2, $3, $4)", [row.workspace_id, row.id, JSON.stringify(row.data), row.created_at]));
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

describe("the workspace's own rules in the database", () => {
  it("are written by owners only and read by every member", async () => {
    await insert("olivia", rule("rule_1", "Databases have owners"));
    await expect(insert("edgar", rule("rule_2", "An editor's rule"))).rejects.toThrow(/row-level security/);
    await expect(insert("stranger", rule("rule_3", "A stranger's rule"))).rejects.toThrow(/row-level security/);
    for (const who of ["olivia", "edgar", "vera"]) {
      const rows = await as(who, (q) => q("select * from public.custom_rules where workspace_id = $1", [ws]));
      expect(rows.map((r) => fromRow("rules", r))).toEqual([{ key: "rule_1", value: rule("rule_1", "Databases have owners") }]);
    }
    expect(await as("stranger", (q) => q("select id from public.custom_rules"))).toEqual([]);
    await as("edgar", (q) => q("update public.custom_rules set data = jsonb_set(data, '{enabled}', 'false') where workspace_id = $1", [ws]));
    expect((await db.query<{ on: boolean }>("select (data ->> 'enabled')::boolean as on from public.custom_rules where workspace_id = $1", [ws])).rows[0].on).toBe(true);
    await expect(db.query("insert into public.custom_rules (workspace_id, id, data) values ($1, 'x', '{\"id\":\"y\"}')", [ws])).rejects.toThrow(/check constraint/);
  });

  it("are written down in the audit log when added, switched, changed and deleted", async () => {
    await as("olivia", (q) => q("update public.custom_rules set data = jsonb_set(data, '{enabled}', 'false') where workspace_id = $1 and id = 'rule_1'", [ws]));
    await as("olivia", (q) => q("update public.custom_rules set data = jsonb_set(data, '{severity}', '\"low\"') where workspace_id = $1 and id = 'rule_1'", [ws]));
    await as("olivia", (q) => q("update public.custom_rules set data = jsonb_set(data, '{enabled}', 'true') where workspace_id = $1 and id = 'rule_1'", [ws]));
    await insert("olivia", rule("rule_gone", "Short-lived"));
    await as("olivia", (q) => q("update public.custom_rules set deleted = true where workspace_id = $1 and id = 'rule_gone'", [ws]));
    const log = (await db.query<{ t: string }>("select actor_name || ' ' || action || ' ' || entity_name as t from public.audit_log where workspace_id = $1 and entity = 'rule' order by id", [ws])).rows.map((r) => r.t);
    expect(log).toEqual(["Olivia created Databases have owners", "Olivia switched off Databases have owners", "Olivia updated Databases have owners", "Olivia switched on Databases have owners", "Olivia created Short-lived", "Olivia deleted Short-lived"]);
  });

  it("go with the model into a scenario, as one event", async () => {
    const scenario = (await as("edgar", (q) => q("select public.create_scenario($1, 'Target', '') as id", [ws])))[0].id as string;
    const copied = (await db.query<{ id: string; title: string }>("select id, data ->> 'title' as title from public.custom_rules where workspace_id = $1 and not deleted", [scenario])).rows;
    expect(copied).toEqual([{ id: "rule_1", title: "Databases have owners" }]);
    expect((await db.query("select action, entity from public.audit_log where workspace_id = $1 order by id", [scenario])).rows).toEqual([{ action: "created", entity: "scenario" }]);
    // The scenario's rules are its own from then on.
    await as("olivia", (q) => q("update public.custom_rules set deleted = true where workspace_id = $1 and id = 'rule_1'", [scenario]));
    expect((await db.query("select 1 from public.custom_rules where workspace_id = $1 and not deleted", [ws])).rows).toHaveLength(1);
  });

  it("are cleared away with the rest once marked deleted, and stop at 200", async () => {
    await db.query("update public.custom_rules set changed_at = now() - interval '40 days' where id = 'rule_gone'");
    await db.exec("alter table public.custom_rules disable trigger stamp_change");
    await db.query("update public.custom_rules set changed_at = now() - interval '40 days' where id = 'rule_gone'");
    await db.exec("alter table public.custom_rules enable trigger stamp_change");
    expect((await as("olivia", (q) => q("select public.purge_deleted($1) as n", [ws])))[0].n).toBe(1);
    await db.query("insert into public.custom_rules (workspace_id, id, data) select $1, 'bulk_' || n, jsonb_build_object('id', 'bulk_' || n, 'title', 'Bulk', 'enabled', true, 'severity', 'low') from generate_series(1, 199) n", [ws]);
    await expect(insert("olivia", rule("one_too_many", "No room"))).rejects.toThrow(/already has 200 rules/);
  });
});
