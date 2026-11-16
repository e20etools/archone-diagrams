import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The audit log (PRD NFR-03), checked on a real Postgres (PGlite) as different signed-in
 * people and through the API: every change is written down by the database, nobody can
 * alter an entry, and only owners read them.
 */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let workspace = "";

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string | null, run: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [who ? JSON.stringify({ sub: ids[who], email: `${who}@example.com` }) : ""]);
    await tx.exec(who ? "set local role authenticated" : "set local role anon");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}
/** The entries written since a point, oldest first, read as the database owner. */
let mark = 0;
const since = async () => {
  const { rows } = await db.query<Record<string, any>>("select * from public.audit_log where id > $1 order by id", [mark]);
  if (rows.length) mark = Number(rows[rows.length - 1].id);
  return rows;
};
const brief = (rows: Record<string, any>[]) => rows.map((r) => `${r.actor_name} ${r.action} ${r.entity} ${r.entity_name}`.trim());

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "vera", "stranger"]) {
    const { rows } = await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [
      `${who}@example.com`,
      { display_name: who === "vera" ? "" : who[0].toUpperCase() + who.slice(1) },
    ]);
    ids[who] = rows[0].id;
  }
  workspace = (await as("olivia", (q) => q("select public.create_workspace('Payments') as id")))[0].id;
}, 60_000);

describe("who may do what, recorded", () => {
  it("records the first owner, invitations and members joining", async () => {
    expect(brief(await since())).toEqual(["Olivia added member Olivia"]);
    await as("olivia", (q) => q("insert into public.workspace_invites (workspace_id, email, role, invited_by) values ($1, 'edgar@example.com', 'editor', $2), ($1, 'vera@example.com', 'viewer', $2)", [workspace, ids.olivia]));
    for (const who of ["edgar", "vera"]) {
      await as(who, async (q) => {
        const invite = (await q("select id from public.my_invites()"))[0].id;
        await q("select public.accept_invite($1)", [invite]);
      });
    }
    const rows = await since();
    expect(brief(rows)).toEqual([
      "Olivia sent invitation edgar@example.com",
      "Olivia sent invitation vera@example.com",
      "Edgar added member Edgar",
      "Edgar closed invitation edgar@example.com",
      // Vera gave no name, so her email stands in for it.
      "vera@example.com added member vera@example.com",
      "vera@example.com closed invitation vera@example.com",
    ]);
    expect(rows[2].changes).toEqual({ role: [null, "editor"] });
    expect(rows[2].actor_id).toBe(ids.edgar);
    expect(rows[2].via).toBe("app");
  });

  it("records a role change and a removal with the role before and after", async () => {
    await as("olivia", (q) => q("update public.workspace_members set role = 'commenter' where workspace_id = $1 and user_id = $2", [workspace, ids.vera]));
    await as("olivia", (q) => q("update public.workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2", [workspace, ids.vera]));
    const rows = await since();
    expect(brief(rows)).toEqual(["Olivia role changed member vera@example.com", "Olivia role changed member vera@example.com"]);
    expect(rows[0].changes).toEqual({ role: ["viewer", "commenter"] });
  });
});

describe("changes to the model, recorded", () => {
  it("records a new object with what it holds, and leaves empty fields out", async () => {
    await as("edgar", (q) => q("insert into public.objects (workspace_id, id, type_id, name, owner, tags) values ($1, 'o1', 'service', 'Ledger', 'Finance', '{tier-1}'), ($1, 'o2', 'database', 'Ledger DB', '', '{}')", [workspace]));
    const rows = await since();
    expect(brief(rows)).toEqual(["Edgar created object Ledger", "Edgar created object Ledger DB"]);
    expect(rows[0].changes).toEqual({ name: [null, "Ledger"], type_id: [null, "service"], owner: [null, "Finance"], tags: [null, ["tier-1"]], lifecycle: [null, "active"], provenance: [null, { origin: "manual" }] });
    expect(rows[0].entity_id).toBe("o1");
    expect(Object.keys(rows[1].changes)).not.toContain("owner");
  });

  it("records each changed field with its value before and after, and nothing when nothing changed", async () => {
    await as("olivia", (q) => q("update public.objects set owner = 'Treasury', lifecycle = 'deprecated' where workspace_id = $1 and id = 'o1'", [workspace]));
    await as("olivia", (q) => q("update public.objects set owner = 'Treasury', updated_at = now() where workspace_id = $1 and id = 'o1'", [workspace]));
    const rows = await since();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("updated");
    expect(rows[0].changes).toEqual({ owner: ["Finance", "Treasury"], lifecycle: ["active", "deprecated"] });
  });

  it("names a relationship by its two ends, and records deleting and restoring", async () => {
    await as("edgar", (q) => q("insert into public.relationships (workspace_id, id, source_id, target_id, kind, protocol) values ($1, 'r1', 'o1', 'o2', 'reads_writes', 'TCP')", [workspace]));
    await as("edgar", (q) => q("update public.relationships set deleted = true where workspace_id = $1 and id = 'r1'", [workspace]));
    await as("edgar", (q) => q("update public.relationships set deleted = false where workspace_id = $1 and id = 'r1'", [workspace]));
    const rows = await since();
    expect(brief(rows)).toEqual(["Edgar created relationship Ledger → Ledger DB", "Edgar deleted relationship Ledger → Ledger DB", "Edgar restored relationship Ledger → Ledger DB"]);
    expect(rows[0].changes).toMatchObject({ kind: [null, "reads_writes"], protocol: [null, "TCP"] });
    expect(rows[1].changes).toEqual({});
  });

  it("records a box put on a diagram or taken off it, but not a box being moved", async () => {
    await as("edgar", async (q) => {
      await q("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd1', 'Overview', 'landscape')", [workspace]);
      await q("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd1', 'o1', 10, 20), ($1, 'd1', 'o2', 10, 200)", [workspace]);
    });
    expect(brief(await since())).toEqual(["Edgar created diagram Overview", "Edgar object added diagram Overview", "Edgar object added diagram Overview"]);
    await as("edgar", (q) => q("update public.diagram_nodes set x = 400, pinned = true where workspace_id = $1 and object_id = 'o1'", [workspace]));
    expect(await since()).toEqual([]);
    await as("edgar", (q) => q("update public.diagram_nodes set deleted = true where workspace_id = $1 and object_id = 'o2'", [workspace]));
    const rows = await since();
    expect(brief(rows)).toEqual(["Edgar object removed diagram Overview"]);
    expect(rows[0].changes).toEqual({ object: "Ledger DB" });
  });

  it("does not repeat a deletion when deleted rows are cleared away, or list the boxes of a deleted diagram", async () => {
    await as("edgar", async (q) => {
      await q("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd2', 'Scratch', 'custom')", [workspace]);
      await q("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd2', 'o1', 0, 0)", [workspace]);
      await q("update public.diagrams set deleted = true where workspace_id = $1 and id = 'd2'", [workspace]);
      await q("update public.diagram_nodes set deleted = true where workspace_id = $1 and diagram_id = 'd2'", [workspace]);
    });
    expect(brief(await since())).toEqual(["Edgar created diagram Scratch", "Edgar object added diagram Scratch", "Edgar deleted diagram Scratch"]);
    await db.query("delete from public.diagram_nodes where diagram_id = 'd2'");
    await db.query("delete from public.diagrams where id = 'd2'");
    expect(await since()).toEqual([]);
  });
});

describe("versions, review and integrations, recorded", () => {
  it("records versions and each step of a review", async () => {
    await as("olivia", (q) => q("select public.save_version($1, 'Before audit', '')", [workspace]));
    await as("olivia", (q) => q("select public.set_review_settings($1, true, $2)", [workspace, JSON.stringify([{ id: "s1", name: "Architecture", reviewerId: ids.olivia, checklist: ["Owners named"] }])]));
    await as("edgar", (q) => q("update public.objects set owner = 'Group finance' where workspace_id = $1 and id = 'o1'", [workspace]));
    const review = (await as("edgar", (q) => q("select public.submit_review($1, 'Owner change', '') as id", [workspace])))[0].id;
    await as("olivia", (q) => q("select public.decide_review($1, false, 'Name the cost centre too', '[true]')", [review]));
    const rows = await since();
    const lines = brief(rows);
    expect(lines).toContain("Olivia created version Before audit");
    expect(lines).toContain("Edgar submitted review Owner change");
    expect(lines).toContain("Olivia rejected review Owner change");
    expect(lines.some((l) => l.startsWith("Olivia updated workspace Payments"))).toBe(true);
    const settings = rows.find((r) => r.entity === "workspace" && "review_required" in r.changes)!;
    expect(settings.changes.review_required).toEqual([false, true]);
    expect(rows.find((r) => r.action === "rejected")!.changes).toEqual({ stage: "Architecture", reason: "Name the cost centre too" });
    // A snapshot is the whole model; it is never copied into the log.
    expect(JSON.stringify(rows)).not.toContain('"snapshot"');
  });

  it("records keys, webhooks and live links without their secrets", async () => {
    const key = (await as("olivia", (q) => q("select * from public.create_api_key($1, 'CI', 'write')", [workspace])))[0];
    const hook = (await as("olivia", (q) => q("select * from public.create_webhook($1, 'https://hooks.example.com/archone')", [workspace])))[0];
    const token = (await as("olivia", (q) => q("select public.create_embed($1, 'd1') as token", [workspace])))[0].token;
    const embed = (await db.query<{ id: string }>("select id from public.embeds where token = $1", [token])).rows[0].id;
    await as("olivia", (q) => q("select public.revoke_embed($1)", [embed]));
    const rows = await since();
    expect(brief(rows)).toEqual(["Olivia created API key CI", "Olivia created webhook https://hooks.example.com/archone", "Olivia created live link Overview", "Olivia switched off live link Overview"]);
    const text = JSON.stringify(rows);
    for (const secret of [key.key, hook.secret, token]) expect(text).not.toContain(secret);
    expect(text).not.toContain("key_hash");

    // A change made through the API is recorded under the key's name.
    const reply = (await as(null, (q) => q("select public.api_request($1, 'POST', '/objects', '{}', $2) as reply", [key.key, JSON.stringify({ name: "Risk engine", typeId: "service" })])))[0].reply;
    expect(reply.status).toBe(201);
    await as(null, (q) => q("select public.api_request($1, 'GET', '/objects', '{}', null)", [key.key]));
    const viaApi = await since();
    expect(brief(viaApi)).toEqual(['API key "CI" created object Risk engine']);
    expect(viaApi[0]).toMatchObject({ via: "api", actor_id: null });
    expect(viaApi[0].changes.provenance[1]).toMatchObject({ origin: "api" });

    await as("olivia", (q) => q("select public.revoke_api_key($1)", [key.id]));
    expect(brief(await since())).toEqual(["Olivia switched off API key CI"]);
    expect((await as(null, (q) => q("select public.api_request($1, 'GET', '/objects', '{}', null) as reply", [key.key])))[0].reply.status).toBe(401);
  });

  it("marks a change made with no person and no key as the system's", async () => {
    await db.query("update public.objects set technology = 'Go' where id = 'o1'");
    const rows = await since();
    expect(rows[0]).toMatchObject({ actor_name: "System", via: "system", actor_id: null, changes: { technology: ["", "Go"] } });
  });
});

describe("the log itself", () => {
  it("is read by owners only", async () => {
    const count = async (who: string | null) => {
      try {
        return (await as(who, (q) => q("select id from public.audit_log"))).length;
      } catch (error) {
        return /permission denied/i.test(String((error as Error).message)) ? "denied" : String(error);
      }
    };
    expect(await count("olivia")).toBeGreaterThan(20);
    expect(await count("edgar")).toBe(0);
    expect(await count("vera")).toBe(0);
    expect(await count("stranger")).toBe(0);
    expect(await count(null)).toBe("denied");
  });

  it("cannot be written, changed or emptied by anyone, the database owner included", async () => {
    const insert = "insert into public.audit_log (workspace_id, actor_name, via, entity, entity_id, action) values ($1, 'Olivia', 'app', 'object', 'x', 'created')";
    await expect(as("olivia", (q) => q(insert, [workspace]))).rejects.toThrow(/permission denied/);
    await expect(as("olivia", (q) => q("update public.audit_log set actor_name = 'Nobody'"))).rejects.toThrow(/permission denied/);
    await expect(as("olivia", (q) => q("delete from public.audit_log"))).rejects.toThrow(/permission denied/);
    await expect(as("olivia", (q) => q("select public.audit_write($1, 'object', 'x', 'Forged', 'created')", [workspace]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.audit_log set actor_name = 'Nobody'")).rejects.toThrow(/cannot be changed/);
    await expect(db.query("delete from public.audit_log")).rejects.toThrow(/cannot be changed/);
    await expect(db.query("truncate public.audit_log")).rejects.toThrow(/cannot be changed/);
  });

  it("keeps the name of someone whose account is later removed", async () => {
    await db.query("delete from auth.users where id = $1", [ids.edgar]);
    const { rows } = await db.query<Record<string, any>>("select actor_name, action, entity_name from public.audit_log where actor_id = $1 or (entity = 'member' and entity_id = $2) order by id", [ids.edgar, ids.edgar]);
    expect(rows.filter((r) => r.actor_name === "Edgar").length).toBeGreaterThan(5);
    // The removal itself is recorded, by the system, since no person in the workspace did it.
    expect(rows.at(-1)).toMatchObject({ actor_name: "System", action: "removed" });
  });

  it("goes when its workspace is deleted, and not before", async () => {
    await as("olivia", (q) => q("delete from public.workspaces where id = $1", [workspace]));
    expect((await db.query("select 1 from public.audit_log where workspace_id = $1", [workspace])).rows).toHaveLength(0);
  });
});

describe("scenarios", () => {
  let main = "";
  let scenario = "";
  it("copies the model and the people who see the working model, and nothing that was deleted", async () => {
    main = (await as("olivia", (q) => q("select public.create_workspace('Core') as id")))[0].id;
    await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'editor')", [main, ids.vera, ids.stranger]);
    await as("olivia", async (q) => {
      await q("insert into public.objects (workspace_id, id, type_id, name, fields) values ($1, 'a', 'service', 'Billing', '{\"Tier\":\"1\"}'), ($1, 'b', 'database', 'Billing DB', '{}'), ($1, 'x', 'service', 'Gone', '{}')", [main]);
      await q("update public.objects set deleted = true where workspace_id = $1 and id = 'x'", [main]);
      await q("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r', 'a', 'b', 'reads_writes')", [main]);
      await q("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd', 'Billing', 'landscape')", [main]);
      await q("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y, pinned) values ($1, 'd', 'a', 5, 6, true)", [main]);
    });
    await since();
    scenario = (await as("stranger", (q) => q("select public.create_scenario($1, ' Move to cloud ', 'Target state 2027') as id", [main])))[0].id;
    const count = async (table: string) => Number((await db.query<{ n: number }>(`select count(*) as n from public.${table} where workspace_id = $1 and not deleted`, [scenario])).rows[0].n);
    expect([await count("objects"), await count("relationships"), await count("diagrams"), await count("diagram_nodes")]).toEqual([2, 1, 1, 1]);
    expect((await db.query("select name, scenario_of, scenario_note from public.workspaces where id = $1", [scenario])).rows[0]).toEqual({ name: "Move to cloud", scenario_of: main, scenario_note: "Target state 2027" });
    expect((await db.query("select fields, changed_by from public.objects where workspace_id = $1 and id = 'a'", [scenario])).rows[0]).toMatchObject({ fields: { Tier: "1" } });
    expect((await db.query("select x, pinned from public.diagram_nodes where workspace_id = $1", [scenario])).rows[0]).toEqual({ x: 5, pinned: true });
    const members = (await db.query<{ user_id: string; role: string }>("select user_id, role from public.workspace_members where workspace_id = $1", [scenario])).rows;
    expect(members.map((m) => m.role).sort()).toEqual(["editor", "owner"]);
    expect(members.some((m) => m.user_id === ids.vera)).toBe(false);
  });
  it("records the copy as one event on each side, not one per row", async () => {
    const rows = await since();
    expect(rows.map((r) => `${r.workspace_id === main ? "main" : "scenario"}: ${r.actor_name} ${r.action} ${r.entity} ${r.entity_name}`)).toEqual(["main: Stranger created scenario Move to cloud", "scenario: Stranger created scenario Move to cloud"]);
    expect(rows[1].changes).toEqual({ "copied from": "Core" });
  });
  it("lets the scenario change without touching the main model, and records those changes as usual", async () => {
    await as("stranger", (q) => q("update public.objects set technology = 'Aurora' where workspace_id = $1 and id = 'b'", [scenario]));
    expect((await db.query("select technology from public.objects where workspace_id = $1 and id = 'b'", [main])).rows[0]).toEqual({ technology: "" });
    expect(brief(await since())).toEqual(["Stranger updated object Billing DB"]);
  });
  it("is refused to viewers and outsiders, and a scenario cannot be branched again", async () => {
    await expect(as("vera", (q) => q("select public.create_scenario($1, 'Mine')", [main]))).rejects.toThrow(/Only owners and editors/);
    await expect(as("olivia", (q) => q("select public.create_scenario($1, 'Nested')", [scenario]))).rejects.toThrow(/cannot have scenarios of its own/);
    expect((await as("vera", (q) => q("select id from public.workspaces where id = $1", [scenario]))).length).toBe(0);
  });
  it("goes when the main workspace is deleted", async () => {
    await as("olivia", (q) => q("delete from public.workspaces where id = $1", [main]));
    expect((await db.query("select 1 from public.workspaces where id = $1", [scenario])).rows).toHaveLength(0);
  });
});

describe("an editor limited to domains", () => {
  let ws = "";
  const tryIt = async (who: string, sql: string, params: unknown[] = []) => {
    try {
      await as(who, (q) => q(sql, params));
      return "ok";
    } catch (error) {
      return /only change what is inside/i.test(String((error as Error).message)) ? "outside" : String((error as Error).message);
    }
  };
  it("is set by an owner, for editors only, with domains that exist", async () => {
    ws = (await as("olivia", (q) => q("select public.create_workspace('Group') as id")))[0].id;
    await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, ids.stranger, ids.vera]);
    await as("olivia", (q) =>
      q(
        `insert into public.objects (workspace_id, id, type_id, name, parent_id) values
          ($1, 'pay', 'domain', 'Payments', null), ($1, 'hr', 'domain', 'People', null),
          ($1, 'ps', 'system', 'Card platform', 'pay'), ($1, 'pa', 'service', 'Authoriser', 'ps'),
          ($1, 'hs', 'system', 'Payroll', 'hr'), ($1, 'loose', 'system', 'Intranet', null)`,
        [ws],
      ),
    );
    await as("olivia", (q) => q("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r-hr', 'hs', 'loose', 'calls'), ($1, 'r-in', 'hs', 'pa', 'calls')", [ws]));
    await expect(as("stranger", (q) => q("select public.set_member_domains($1, $2, '{pay}')", [ws, ids.stranger]))).rejects.toThrow(/Only an owner/);
    await expect(as("olivia", (q) => q("select public.set_member_domains($1, $2, '{pay}')", [ws, ids.vera]))).rejects.toThrow(/Only an editor/);
    await expect(as("olivia", (q) => q("select public.set_member_domains($1, $2, '{ps}')", [ws, ids.stranger]))).rejects.toThrow(/domains that exist/);
    await since();
    await as("olivia", (q) => q("select public.set_member_domains($1, $2, '{pay}')", [ws, ids.stranger]));
    const rows = await since();
    expect(brief(rows)).toEqual(["Olivia limit changed member Stranger"]);
    expect(rows[0].changes).toEqual({ domains: [[], ["Payments"]] });
    const people = await as("vera", (q) => q("select display_name, role, domains from public.workspace_people($1)", [ws]));
    expect(people.find((p) => p.display_name === "Stranger")).toMatchObject({ role: "editor", domains: ["pay"] });
  });
  it("changes what is inside the domain, at any depth, and nothing else", async () => {
    expect(await tryIt("stranger", "update public.objects set owner = 'Cards' where workspace_id = $1 and id = 'pa'", [ws])).toBe("ok");
    expect(await tryIt("stranger", "insert into public.objects (workspace_id, id, type_id, name, parent_id) values ($1, 'new', 'database', 'Card vault', 'ps')", [ws])).toBe("ok");
    expect(await tryIt("stranger", "update public.objects set deleted = true where workspace_id = $1 and id = 'new'", [ws])).toBe("ok");
    expect(await tryIt("stranger", "update public.objects set owner = 'Mine' where workspace_id = $1 and id = 'hs'", [ws])).toBe("outside");
    expect(await tryIt("stranger", "update public.objects set name = 'Pay' where workspace_id = $1 and id = 'pay'", [ws])).toBe("outside");
    expect(await tryIt("stranger", "update public.objects set owner = 'Mine' where workspace_id = $1 and id = 'loose'", [ws])).toBe("outside");
    expect(await tryIt("stranger", "insert into public.objects (workspace_id, id, type_id, name) values ($1, 'top', 'system', 'Top level')", [ws])).toBe("outside");
    expect(await tryIt("stranger", "insert into public.objects (workspace_id, id, type_id, name, parent_id) values ($1, 'sneak', 'service', 'Sneak', 'hs')", [ws])).toBe("outside");
    // Moving something out of the domain, or pulling something into it, is a change on both sides.
    expect(await tryIt("stranger", "update public.objects set parent_id = 'hs' where workspace_id = $1 and id = 'pa'", [ws])).toBe("outside");
    expect(await tryIt("stranger", "update public.objects set parent_id = 'pay' where workspace_id = $1 and id = 'hs'", [ws])).toBe("outside");
  });
  it("draws and changes relationships that touch the domain, and no others", async () => {
    expect(await tryIt("stranger", "insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r-out', 'pa', 'loose', 'calls')", [ws])).toBe("ok");
    expect(await tryIt("stranger", "update public.relationships set protocol = 'TLS' where workspace_id = $1 and id = 'r-in'", [ws])).toBe("ok");
    expect(await tryIt("stranger", "update public.relationships set deleted = true where workspace_id = $1 and id = 'r-hr'", [ws])).toBe("outside");
    expect(await tryIt("stranger", "insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r-x', 'loose', 'hs', 'calls')", [ws])).toBe("outside");
    // Re-pointing it so that neither end is in the domain any more is refused too.
    expect(await tryIt("stranger", "update public.relationships set target_id = 'loose' where workspace_id = $1 and id = 'r-in'", [ws])).toBe("outside");
  });
  it("still arranges diagrams, and leaves owners and unlimited editors alone", async () => {
    expect(await tryIt("stranger", "insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd', 'Mine', 'custom')", [ws])).toBe("ok");
    expect(await tryIt("stranger", "insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd', 'hs', 0, 0)", [ws])).toBe("ok");
    expect(await tryIt("olivia", "update public.objects set owner = 'HR' where workspace_id = $1 and id = 'hs'", [ws])).toBe("ok");
  });
  it("loses the limit when the role changes or an owner lifts it", async () => {
    await as("olivia", (q) => q("select public.set_member_domains($1, $2, null)", [ws, ids.stranger]));
    expect(await tryIt("stranger", "update public.objects set owner = 'Anyone' where workspace_id = $1 and id = 'hs'", [ws])).toBe("ok");
    await as("olivia", (q) => q("select public.set_member_domains($1, $2, '{hr}')", [ws, ids.stranger]));
    await as("olivia", (q) => q("update public.workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2", [ws, ids.stranger]));
    await as("olivia", (q) => q("update public.workspace_members set role = 'editor' where workspace_id = $1 and user_id = $2", [ws, ids.stranger]));
    expect((await db.query("select domains from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, ids.stranger])).rows[0]).toEqual({ domains: null });
  });
});

describe("notations", () => {
  it("stores a diagram's notation, the process step types and the 'then' relationship, and copies the notation into a scenario", async () => {
    const ws = (await as("olivia", (q) => q("select public.create_workspace('Processes') as id")))[0].id;
    await as("olivia", async (q) => {
      await q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'p', 'process', 'Claims'), ($1, 't1', 'task', 'Check', null), ($1, 'e1', 'event', 'Done', null)".replace(/, null\)/g, ")"), [ws]);
      await q("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'f', 't1', 'e1', 'flows_to')", [ws]);
      await q("insert into public.diagrams (workspace_id, id, name, view_type, notation) values ($1, 'b', 'Claims flow', 'custom', 'bpmn'), ($1, 'plain', 'Overview', 'landscape', null)", [ws]);
    });
    await expect(as("olivia", (q) => q("update public.diagrams set notation = 'uml' where workspace_id = $1", [ws]))).rejects.toThrow(/check constraint/);
    await expect(as("olivia", (q) => q("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'bad', 't1', 'e1', 'teleports_to')", [ws]))).rejects.toThrow(/check constraint/);
    expect((await db.query("select id from public.object_types where id in ('process', 'task', 'event', 'decision') order by id")).rows).toHaveLength(4);
    const copy = (await as("olivia", (q) => q("select public.create_scenario($1, 'To be') as id", [ws])))[0].id;
    expect((await db.query("select id, notation from public.diagrams where workspace_id = $1 order by id", [copy])).rows).toEqual([{ id: "b", notation: "bpmn" }, { id: "plain", notation: null }]);
    const change = (await db.query<{ changes: Record<string, unknown> }>("select changes from public.audit_log where workspace_id = $1 and entity = 'diagram' and entity_name = 'Claims flow'", [ws])).rows[0].changes;
    expect(change.notation).toEqual([null, "bpmn"]);
  });
});

describe("changes that arrive through the API", () => {
  let ws = "";
  const call = async (key: string, method: string, path: string, body: unknown = null, query: Record<string, string> = {}) =>
    (await as(null, (q) => q("select public.api_request($1, $2, $3, $4, $5) as reply", [key, method, path, JSON.stringify(query), body === null ? null : JSON.stringify(body)])))[0].reply as { status: number; body: any };
  const newKey = async (name: string, access: string) => (await as("olivia", (q) => q("select * from public.create_api_key($1, $2, $3)", [ws, name, access])))[0] as { id: string; key: string };

  beforeAll(async () => {
    ws = (await as("olivia", (q) => q("select public.create_workspace('Agents') as id")))[0].id;
    await as("olivia", (q) =>
      q(
        "insert into public.objects (workspace_id, id, type_id, name, parent_id) values ($1, 'pay', 'domain', 'Payments', null), ($1, 'hr', 'domain', 'People', null), ($1, 'ps', 'system', 'Pay system', 'pay'), ($1, 'hs', 'system', 'HR system', 'hr'), ($1, 'ledger', 'database', 'Ledger', 'ps')",
        [ws],
      ),
    );
    await since();
  });

  it("a key that proposes cannot change the model, only file a proposal", async () => {
    const key = await newKey("Coding agent", "propose");
    await since();
    expect((await call(key.key, "GET", "")).body).toMatchObject({ access: "propose" });
    expect((await call(key.key, "GET", "/objects")).status).toBe(200);
    for (const [method, path, body] of [["POST", "/objects", { name: "X", typeId: "service" }], ["PATCH", "/objects/ps", { owner: "Me" }], ["DELETE", "/objects/ps", null], ["POST", "/relationships", { sourceId: "ps", targetId: "hs" }], ["POST", "/diagrams", { name: "D" }]] as const) {
      const reply = await call(key.key, method, path, body);
      expect([reply.status, reply.body.error.code], `${method} ${path}`).toEqual([403, "propose_only"]);
    }
    expect((await db.query("select count(*)::int as n from public.objects where workspace_id = $1", [ws])).rows[0]).toEqual({ n: 5 });

    const filed = await call(key.key, "POST", "/proposals", {
      title: "Add the support assistant",
      notes: "From pull request 41",
      objects: [
        { key: "bot", name: "Support assistant", typeId: "ai-agent", owner: "Support", parentKey: "ps" },
        { id: "ledger", description: "The book of record" },
        { name: "hr SYSTEM", tags: ["People", "people ", "core"] },
      ],
      relationships: [
        { sourceKey: "bot", targetKey: "ledger", kind: "reads_writes", protocol: "TLS" },
        { sourceKey: "bot", targetKey: "pay" },
      ],
    });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ status: "pending", title: "Add the support assistant" });
    // Nothing reached the model.
    expect((await db.query("select count(*)::int as n from public.objects where workspace_id = $1", [ws])).rows[0]).toEqual({ n: 5 });
    expect((await db.query("select description from public.objects where workspace_id = $1 and id = 'ledger'", [ws])).rows[0]).toEqual({ description: "" });

    const stored = (await db.query<{ data: any }>("select data from public.proposals where workspace_id = $1 and id = $2", [ws, filed.body.id])).rows[0].data;
    expect(stored).toMatchObject({ origin: "api", engine: "API key: Coding agent", source: "Add the support assistant", notes: "From pull request 41", status: "pending", withoutDiagram: true, targetDiagramId: null });
    const byKey = Object.fromEntries(stored.objects.map((o: any) => [o.key, o]));
    expect(byKey.bot).toMatchObject({ name: "Support assistant", typeId: "ai-agent", matchId: null, parentKey: "ps", owner: "Support", decision: "pending", provided: ["type", "owner", "parent"] });
    // An existing object named by id: only the field that was sent will be written.
    expect(byKey.ledger).toMatchObject({ matchId: "ledger", name: "Ledger", typeId: "database", provided: ["description"] });
    // The same name as an existing object means that object.
    expect(byKey.o3).toMatchObject({ matchId: "hs", tags: ["core", "people"], provided: ["tags"] });
    // Ends that name existing objects were added as references that change nothing.
    expect(byKey.pay).toMatchObject({ matchId: "pay", provided: [] });
    expect(stored.relationships).toMatchObject([{ key: "r1", sourceKey: "bot", targetKey: "ledger", kind: "reads_writes", protocol: "TLS" }, { key: "r2", sourceKey: "bot", targetKey: "pay", kind: "calls" }]);
    expect(byKey.ps).toMatchObject({ matchId: "ps", provided: [] });
    expect(brief(await since())).toEqual(['API key "Coding agent" created proposal Add the support assistant']);

    expect((await call(key.key, "GET", "/proposals")).body.data).toHaveLength(1);
    expect((await call(key.key, "GET", `/proposals/${filed.body.id}`)).body.objects).toHaveLength(5);
    expect((await call(key.key, "GET", "/proposals", null, { status: "applied" })).body.data).toEqual([]);
    expect((await call(key.key, "PATCH", `/proposals/${filed.body.id}`, {})).status).toBe(405);
  });

  it("refuses a proposal it cannot make sense of, and says why", async () => {
    const key = await newKey("Sloppy", "propose");
    const bad = async (body: unknown) => {
      const reply = await call(key.key, "POST", "/proposals", body);
      return `${reply.status} ${reply.body.error?.message ?? ""}`;
    };
    expect(await bad({ objects: [{ name: "A" }] })).toMatch(/^422 "title" is required/);
    expect(await bad({ title: "T" })).toMatch(/^422 A proposal needs at least one/);
    expect(await bad({ title: "T", objects: [{ typeId: "service" }] })).toMatch(/^422 Every new object needs a "name"/);
    expect(await bad({ title: "T", objects: [{ name: "A", typeId: "spaceship" }] })).toMatch(/^422 "typeId" has to be one of/);
    expect(await bad({ title: "T", objects: [{ id: "nope" }] })).toMatch(/^422 "id" nope is not an object/);
    expect(await bad({ title: "T", objects: [{ key: "a", name: "A" }, { key: "a", name: "B" }] })).toMatch(/^422 The key "a" is used twice/);
    expect(await bad({ title: "T", objects: [{ key: "a", name: "A", parentKey: "ghost" }] })).toMatch(/^422 The "parentKey" ghost is neither a key/);
    expect(await bad({ title: "T", relationships: [{ sourceKey: "ps", targetKey: "ghost" }] })).toMatch(/^422 "ghost" is neither a key/);
    expect(await bad({ title: "T", relationships: [{ sourceKey: "ps", targetKey: "hs", kind: "teleports_to" }] })).toMatch(/^422 "kind" has to be one of/);
    expect(await bad({ title: "T", diagramId: "nope", objects: [{ name: "A" }] })).toMatch(/^422 "diagramId" nope is not a diagram/);
    expect(await bad({ title: "T", objects: Array.from({ length: 201 }, (_, i) => ({ name: `N${i}` })) })).toMatch(/^422 A proposal holds at most/);
    expect((await db.query("select count(*)::int as n from public.proposals where workspace_id = $1", [ws])).rows[0]).toEqual({ n: 1 });
    // A read key still cannot propose; a write key can.
    expect((await call((await newKey("Reader", "read")).key, "POST", "/proposals", { title: "T", objects: [{ name: "A" }] })).body.error.code).toBe("read_only");
    expect((await call((await newKey("Writer", "write")).key, "POST", "/proposals", { title: "By a writer", objects: [{ name: "A" }] })).status).toBe(201);
    await expect(as("olivia", (q) => q("select * from public.create_api_key($1, 'Bad', 'admin')", [ws]))).rejects.toThrow(/read, propose or write/);
  });

  it("records what a person decides about a proposal", async () => {
    await since();
    const id = (await db.query<{ id: string }>("select id from public.proposals where workspace_id = $1 and data ->> 'source' = 'Add the support assistant'", [ws])).rows[0].id;
    await as("olivia", (q) => q("update public.proposals set status = 'applied', data = data || '{\"status\":\"applied\",\"decidedBy\":\"Olivia\"}' where workspace_id = $1 and id = $2", [ws, id]));
    const rows = await since();
    expect(brief(rows)).toEqual(["Olivia applied proposal Add the support assistant"]);
    expect(rows[0].changes).toEqual({ origin: "api", from: "API key: Coding agent" });
    const key = await newKey("Asker", "propose");
    expect((await call(key.key, "GET", `/proposals/${id}`)).body).toMatchObject({ status: "applied", decidedBy: "Olivia" });
  });

  it("limits a write key to domains, like an editor", async () => {
    const key = await newKey("Payments sync", "write");
    await expect(as("edgar", (q) => q("select public.set_api_key_domains($1, '{pay}')", [key.id]))).rejects.toThrow(/Only an owner/);
    await expect(as("olivia", (q) => q("select public.set_api_key_domains($1, '{ps}')", [key.id]))).rejects.toThrow(/has to be a domain/);
    const proposer = await newKey("P", "propose");
    await expect(as("olivia", (q) => q("select public.set_api_key_domains($1, '{pay}')", [proposer.id]))).rejects.toThrow(/Only a key with write access/);
    await as("olivia", (q) => q("select public.set_api_key_domains($1, '{pay}')", [key.id]));
    expect((await as("olivia", (q) => q("select domains from public.api_keys where id = $1", [key.id])))[0]).toEqual({ domains: ["pay"] });

    expect((await call(key.key, "PATCH", "/objects/ps", { owner: "Payments team" })).status).toBe(200);
    expect((await call(key.key, "POST", "/objects", { name: "Card vault", typeId: "database", parentId: "ps" })).status).toBe(201);
    const outside = await call(key.key, "PATCH", "/objects/hs", { owner: "Not mine" });
    expect([outside.status, outside.body.error.code, outside.body.error.message]).toEqual([403, "outside_limit", "You can only change what is inside the domains you were given."]);
    expect((await call(key.key, "POST", "/objects", { name: "Loose", typeId: "system" })).status).toBe(403);
    expect((await call(key.key, "POST", "/relationships", { sourceId: "hs", targetId: "hr" })).status).toBe(403);
    expect((await call(key.key, "POST", "/relationships", { sourceId: "ps", targetId: "hs" })).status).toBe(201);
    expect((await db.query("select owner from public.objects where workspace_id = $1 and id = 'hs'", [ws])).rows[0]).toEqual({ owner: "" });

    // A person's own limit is untouched by keys, and an unlimited key still writes anywhere.
    expect((await call((await newKey("Everything", "write")).key, "PATCH", "/objects/hs", { owner: "HR" })).status).toBe(200);
    await as("olivia", (q) => q("select public.set_api_key_domains($1, null)", [key.id]));
    expect((await call(key.key, "PATCH", "/objects/hs", { owner: "Anyone" })).status).toBe(200);
  });

  it("knows the AI object types", async () => {
    expect((await db.query("select id from public.object_types where id in ('ai-agent', 'ai-model', 'mcp-server') order by id")).rows).toHaveLength(3);
  });
});

describe("a log that shows tampering", () => {
  let chained = "";
  const verify = async (who: string, anchor?: [number, string]) => (await as(who, (q) => q("select public.verify_audit_log($1, $2, $3) as v", [chained, anchor?.[0] ?? null, anchor?.[1] ?? null])))[0].v;
  const raw = (sql: string, params?: unknown[]) => db.query<Record<string, any>>(sql, params);
  /** Changes the log as someone with full access to the database would, checks it as the owner, and undoes the change. */
  const tampered = async (sql: string, params: unknown[]) =>
    db.transaction(async (tx) => {
      await tx.exec("alter table public.audit_log disable trigger append_only");
      await tx.query(sql, params);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.nora })]);
      const result = (await tx.query<{ v: any }>("select public.verify_audit_log($1) as v", [chained])).rows[0].v;
      await tx.rollback();
      return result;
    });

  beforeAll(async () => {
    // Accounts of the earlier tests have been deleted by now; these are new people.
    for (const who of ["nora", "emil", "passer"]) {
      const { rows } = await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who[0].toUpperCase() + who.slice(1) }]);
      ids[who] = rows[0].id;
    }
    chained = (await as("nora", (q) => q("select public.create_workspace('Chained') as id")))[0].id;
    await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor')", [chained, ids.emil]);
    for (let i = 0; i < 12; i++) await as("emil", (q) => q("insert into public.objects (workspace_id, id, type_id, name) values ($1, $2, 'service', $3)", [chained, `c${i}`, `Service ${i}`]));
  });

  it("chains every entry to the one before it, in the order they were written", async () => {
    const rows = (await raw("select id, prev_hash, hash from public.audit_log where workspace_id = $1 order by id", [chained])).rows;
    expect(rows.length).toBe(14);
    expect(rows[0].prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(rows.length);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
    const result = await verify("nora");
    expect(result).toMatchObject({ ok: true, entries: rows.length, brokenAt: null, anchor: null });
    expect(result.head).toMatchObject({ id: Number(rows.at(-1)!.id), hash: rows.at(-1)!.hash });
  });

  it("keeps each workspace's chain apart", async () => {
    const other = (await as("nora", (q) => q("select public.create_workspace('Other chain') as id")))[0].id;
    const first = (await raw("select prev_hash from public.audit_log where workspace_id = $1 order by id limit 1", [other])).rows[0];
    expect(first.prev_hash).toBeNull();
    expect((await verify("nora")).ok).toBe(true);
  });

  it("is checked only by an owner", async () => {
    await expect(verify("emil")).rejects.toThrow(/Only an owner/);
    await expect(verify("passer")).rejects.toThrow(/Only an owner/);
  });

  it("finds an entry that was changed, and one that was removed", async () => {
    const rows = (await raw("select id from public.audit_log where workspace_id = $1 order by id", [chained])).rows;
    const victim = Number(rows[5].id);
    expect(await tampered("update public.audit_log set actor_name = 'Somebody else' where id = $1", [victim])).toMatchObject({ ok: false, brokenAt: victim, entries: 5, head: null });
    expect(await tampered("update public.audit_log set changes = '{\"name\": [null, \"Other\"]}' where id = $1", [victim])).toMatchObject({ ok: false, brokenAt: victim });
    // Without an entry, the one after it no longer follows from the one before.
    expect(await tampered("delete from public.audit_log where id = $1", [victim])).toMatchObject({ ok: false, brokenAt: Number(rows[6].id), entries: 5 });
    expect((await verify("nora")).ok).toBe(true);
  });

  it("checks against a number and hash that were saved outside, which also shows a cut-off end", async () => {
    const head = (await verify("nora")).head;
    expect((await verify("nora", [head.id, head.hash])).anchor).toBe("match");
    expect(await verify("nora", [head.id, "0".repeat(64)])).toMatchObject({ ok: false, anchor: "mismatch" });
    // A later entry leaves the saved one where it was.
    await as("emil", (q) => q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'chain1', 'service', 'Chained')", [chained]));
    const after = await verify("nora", [head.id, ` ${String(head.hash).toUpperCase()} `]);
    expect(after).toMatchObject({ ok: true, anchor: "match" });
    expect(after.head.id).toBeGreaterThan(head.id);
    // Cutting entries off the end leaves a chain that holds; only the saved hash shows it.
    const cut = await db.transaction(async (tx) => {
      await tx.exec("alter table public.audit_log disable trigger append_only");
      await tx.query("delete from public.audit_log where workspace_id = $1 and id >= $2", [chained, after.head.id]);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.nora })]);
      const result = (await tx.query<{ v: any }>("select public.verify_audit_log($1, $2, $3) as v", [chained, after.head.id, after.head.hash])).rows[0].v;
      await tx.rollback();
      return result;
    });
    expect(cut).toMatchObject({ ok: false, brokenAt: null, anchor: "missing" });
  });

  it("still refuses changes to an entry, hash included", async () => {
    await expect(raw("update public.audit_log set hash = 'x' where workspace_id = $1", [chained])).rejects.toThrow(/cannot be changed/);
  });

  describe("the dependency handshake", () => {
    const row = async () => (await raw("select acknowledged, protocol from public.relationships where workspace_id = $1 and id = 'hs1'", [chained])).rows[0];
    const logged = async () => (await raw("select entity, action, changes from public.audit_log where workspace_id = $1 and entity = 'relationship' order by id", [chained])).rows;

    it("stores a confirmation, records it, and clears it when the relationship changes", async () => {
      await as("emil", async (q) => {
        await q("insert into public.objects (workspace_id, id, type_id, name, owner) values ($1, 'hsa', 'service', 'Hand A', 'Team A'), ($1, 'hsb', 'service', 'Hand B', 'Team B')", [chained]);
        await q("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'hs1', 'hsa', 'hsb', 'calls')", [chained]);
      });
      await as("emil", (q) => q("update public.relationships set acknowledged = $2 where workspace_id = $1 and id = 'hs1'", [chained, JSON.stringify({ by: "Team B", at: "2026-03-01T00:00:00.000Z" })]));
      expect((await row()).acknowledged).toEqual({ by: "Team B", at: "2026-03-01T00:00:00.000Z" });
      const entries = await logged();
      expect(entries.map((e) => e.action)).toEqual(["created", "updated"]);
      expect(entries[1].changes.acknowledged).toEqual([null, { by: "Team B", at: "2026-03-01T00:00:00.000Z" }]);
      // Saving the same relationship again keeps it.
      await as("emil", (q) => q("update public.relationships set kind = 'calls', updated_at = now() where workspace_id = $1 and id = 'hs1'", [chained]));
      expect((await row()).acknowledged).not.toBeNull();
      await as("emil", (q) => q("update public.relationships set protocol = 'HTTPS' where workspace_id = $1 and id = 'hs1'", [chained]));
      expect(await row()).toEqual({ acknowledged: null, protocol: "HTTPS" });
      await expect(as("emil", (q) => q("update public.relationships set acknowledged = '\"yes\"' where workspace_id = $1 and id = 'hs1'", [chained]))).rejects.toThrow(/check constraint/);
    });

    it("keeps the confirmation in a saved version", async () => {
      await as("emil", (q) => q("update public.relationships set acknowledged = $2 where workspace_id = $1 and id = 'hs1'", [chained, JSON.stringify({ by: "Team B", at: "2026-03-02T00:00:00.000Z" })]));
      const version = (await as("emil", (q) => q("select public.save_version($1, 'With a handshake') as id", [chained])))[0].id;
      const snapshot = (await raw("select snapshot from public.versions where id = $1", [version])).rows[0].snapshot;
      expect(snapshot.relationships.find((r: any) => r.id === "hs1").acknowledged).toEqual({ by: "Team B", at: "2026-03-02T00:00:00.000Z" });
      expect((await verify("nora")).ok).toBe(true);
    });
  });
});
