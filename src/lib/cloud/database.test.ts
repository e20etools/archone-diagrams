import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { KEY_COLUMNS, SQL_TABLE, fromRow, toRow } from "./rows";
import { TABLE_NAMES, sameValue, toTables } from "./tables";

/**
 * Runs the real migrations on a real Postgres (PGlite) and checks the access rules as different
 * signed-in people. supabase-shim.sql stands in for Supabase's auth schema and roles.
 */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};

/** Runs statements as one signed-in person, the way requests through Supabase's API do. */
async function as<T>(who: string | null, run: (q: (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [who ? JSON.stringify({ sub: ids[who], email: `${who}@example.com` }) : ""]);
    await tx.exec(who ? "set local role authenticated" : "set local role anon");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}
const denied = async (who: string | null, sql: string, params?: unknown[]) => {
  try {
    const rows = await as(who, (q) => q(sql, params));
    return rows.length === 0 ? "nothing" : "allowed";
  } catch (error) {
    return /permission denied|row-level security|42501/i.test(String((error as Error).message)) ? "denied" : `error: ${(error as Error).message}`;
  }
};

async function upsert(q: (sql: string, params?: unknown[]) => Promise<unknown>, table: (typeof TABLE_NAMES)[number], row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const keys = KEY_COLUMNS[table];
  const sql = `insert into public.${SQL_TABLE[table]} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})
    on conflict (${keys.join(", ")}) do update set ${columns.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ")}`;
  await q(sql, columns.map((c) => row[c]));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "vera", "carl", "stranger", "unconfirmed"]) {
    const { rows } = await db.query<{ id: string }>(
      "insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3) returning id",
      [`${who}@example.com`, who === "unconfirmed" ? null : new Date().toISOString(), { display_name: who[0].toUpperCase() + who.slice(1) }],
    );
    ids[who] = rows[0].id;
  }
}, 60_000);

describe("database access rules", () => {
  let workspace = "";

  it("creates a profile for every new account", async () => {
    const rows = await as("olivia", (q) => q("select email, display_name from public.profiles"));
    expect(rows).toEqual([{ email: "olivia@example.com", display_name: "Olivia" }]);
  });

  it("lets a signed-in person create a workspace and makes them its owner", async () => {
    workspace = (await as("olivia", (q) => q("select public.create_workspace('  Payments  ') as id")))[0].id;
    const mine = await as("olivia", (q) => q("select w.name, m.role from public.workspaces w join public.workspace_members m on m.workspace_id = w.id"));
    expect(mine).toEqual([{ name: "Payments", role: "owner" }]);
    expect(await denied(null, "select public.create_workspace('x')")).toBe("denied");
    expect(await denied("olivia", "insert into public.workspaces (name) values ('direct') returning id")).toBe("denied");
  });

  it("hides a workspace and its model from people who are not members", async () => {
    await as("olivia", (q) => q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'o1', 'service', 'Ledger')", [workspace]));
    expect(await denied("stranger", "select * from public.workspaces")).toBe("nothing");
    expect(await denied("stranger", "select * from public.objects")).toBe("nothing");
    expect(await denied("stranger", "select * from public.workspace_members")).toBe("nothing");
    expect(await denied("stranger", "insert into public.objects (workspace_id, id, type_id, name) values ($1, 'x', 'service', 'Intruder') returning id", [workspace])).toBe("denied");
    expect(await denied("stranger", "update public.objects set name = 'Hacked' returning id")).toBe("nothing");
    expect(await denied(null, "select * from public.objects")).toBe("denied");
  });

  it("invites by email; only the confirmed owner of that address can accept", async () => {
    for (const [who, role] of [["edgar", "editor"], ["vera", "viewer"], ["carl", "commenter"], ["unconfirmed", "editor"]]) {
      await as("olivia", (q) => q("insert into public.workspace_invites (workspace_id, email, role, invited_by) values ($1, $2, $3, $4)", [workspace, `${who}@example.com`, role, ids.olivia]));
    }
    expect(await denied("olivia", "insert into public.workspace_invites (workspace_id, email, role, invited_by) values ($1, 'boss@example.com', 'owner', $2) returning id", [workspace, ids.olivia])).toMatch(/error/);
    const invite = (await as("edgar", (q) => q("select * from public.my_invites()")))[0];
    expect(invite).toMatchObject({ workspace_name: "Payments", role: "editor", invited_by_name: "Olivia" });
    // Someone else cannot use Edgar's invitation, and an unconfirmed address cannot use its own.
    await expect(as("stranger", (q) => q("select public.accept_invite($1)", [invite.id]))).rejects.toThrow(/no longer exists/);
    expect(await as("unconfirmed", (q) => q("select * from public.my_invites()"))).toEqual([]);
    for (const who of ["edgar", "vera", "carl"]) {
      const own = (await as(who, (q) => q("select id from public.my_invites()")))[0];
      expect((await as(who, (q) => q("select public.accept_invite($1) as ws", [own.id])))[0].ws).toBe(workspace);
    }
    const people = await as("vera", (q) => q("select display_name, role from public.workspace_people($1)", [workspace]));
    expect(people.map((p) => `${p.display_name}:${p.role}`)).toEqual(["Olivia:owner", "Edgar:editor", "Vera:viewer", "Carl:commenter"]);
    expect(await as("stranger", (q) => q("select * from public.workspace_people($1)", [workspace]))).toEqual([]);
  });

  it("lets editors change the model, and viewers and commenters only read it", async () => {
    expect(await denied("edgar", "update public.objects set name = 'Ledger v2' where id = 'o1' returning id")).toBe("allowed");
    for (const who of ["vera", "carl"]) {
      expect((await as(who, (q) => q("select name from public.objects")))[0].name).toBe("Ledger v2");
      expect(await denied(who, "update public.objects set name = 'Nope' where id = 'o1' returning id")).toBe("nothing");
      expect(await denied(who, "insert into public.objects (workspace_id, id, type_id, name) values ($1, 'o2', 'service', 'Nope') returning id", [workspace])).toBe("denied");
    }
    expect(await denied("edgar", "delete from public.objects where id = 'o1' returning id")).toBe("denied");
    const stamped = (await as("olivia", (q) => q("select changed_by from public.objects where id = 'o1'")))[0];
    expect(stamped.changed_by).toBe(ids.edgar);
  });

  it("stores every kind of model row exactly as the app sends it", async () => {
    const tables = toTables(demoWorkspace("Olivia"));
    await as("edgar", async (q) => {
      for (const table of TABLE_NAMES) {
        for (const [key, value] of Object.entries(tables[table])) await upsert(q, table, toRow(table, workspace, key, value));
      }
    });
    for (const table of TABLE_NAMES) {
      const rows = await as("vera", (q) => q(`select * from public.${SQL_TABLE[table]} where workspace_id = $1 and not deleted`, [workspace]));
      const back = Object.fromEntries(rows.map((row) => fromRow(table, row)).map((r) => [r.key, r.value]));
      for (const [key, value] of Object.entries(tables[table])) expect(sameValue(back[key], value), `${table} ${key}`).toBe(true);
    }
    // Saving the same rows again is an update, not a duplicate.
    const count = async () => Number((await as("vera", (q) => q("select count(*) as n from public.objects")))[0].n);
    const before = await count();
    await as("edgar", async (q) => {
      for (const [key, value] of Object.entries(tables.objects)) await upsert(q, "objects", toRow("objects", workspace, key, value));
    });
    expect(await count()).toBe(before);
  });

  it("keeps members and roles in the owner's hands, and always one owner", async () => {
    const setRole = "update public.workspace_members set role = $1 where workspace_id = $2 and user_id = $3 returning role";
    expect(await denied("edgar", setRole, ["owner", workspace, ids.edgar])).toBe("nothing");
    expect(await denied("vera", setRole, ["editor", workspace, ids.vera])).toBe("nothing");
    expect(await denied("edgar", "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor') returning role", [workspace, ids.stranger])).toBe("denied");
    expect(await denied("olivia", setRole, ["editor", workspace, ids.vera])).toBe("allowed");
    await expect(as("olivia", (q) => q(setRole, ["editor", workspace, ids.olivia]))).rejects.toThrow(/at least one owner/);
    await expect(as("olivia", (q) => q("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [workspace, ids.olivia]))).rejects.toThrow(/at least one owner/);
    // A member can leave; an owner can remove someone; nobody else can.
    expect(await denied("edgar", "delete from public.workspace_members where user_id = $1 returning role", [ids.carl])).toBe("nothing");
    expect(await denied("carl", "delete from public.workspace_members where user_id = $1 returning role", [ids.carl])).toBe("allowed");
    expect(await denied("carl", "select * from public.objects")).toBe("nothing");
    expect(await denied("olivia", "delete from public.workspace_members where user_id = $1 returning role", [ids.edgar])).toBe("allowed");
    expect(await denied("edgar", "update public.objects set name = 'After removal' returning id")).toBe("nothing");
  });

  it("lets people see co-members' names but not strangers', and rename only themselves", async () => {
    const seen = (await as("vera", (q) => q("select display_name from public.profiles order by display_name"))).map((r) => r.display_name);
    expect(seen).toEqual(["Olivia", "Vera"]);
    expect(await denied("vera", "update public.profiles set display_name = 'V' where id = $1 returning id", [ids.vera])).toBe("allowed");
    expect(await denied("vera", "update public.profiles set display_name = 'X' where id = $1 returning id", [ids.olivia])).toBe("nothing");
    expect(await denied("vera", "update public.profiles set email = 'x@example.com' where id = $1 returning id", [ids.vera])).toBe("denied");
  });

  it("lets only an owner rename or delete the workspace, and deleting removes its data", async () => {
    expect(await denied("vera", "update public.workspaces set name = 'Mine' returning id")).toBe("nothing");
    expect(await denied("vera", "delete from public.workspaces returning id")).toBe("nothing");
    expect(await denied("olivia", "update public.workspaces set name = 'Payments platform' returning id")).toBe("allowed");
    await expect(as("vera", (q) => q("select public.purge_deleted($1)", [workspace]))).rejects.toThrow(/Only an owner/);
    await as("olivia", (q) => q("update public.objects set deleted = true where id = 'o1'"));
    expect((await as("olivia", (q) => q("select public.purge_deleted($1, interval '-1 second') as n", [workspace])))[0].n).toBe(1);
    expect(await denied("olivia", "delete from public.workspaces returning id")).toBe("allowed");
    const left = await db.query("select (select count(*) from public.objects) + (select count(*) from public.workspace_members) + (select count(*) from public.diagram_nodes) as n");
    expect(Number((left.rows[0] as { n: number }).n)).toBe(0);
  });
});
