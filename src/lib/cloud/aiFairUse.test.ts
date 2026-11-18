import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/** Fair use of the AI (PGlite): who may ask, the limits per person and per workspace, and the report. */

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
const begin = async (who: string, kind = "text", workspace = ws, global = 0) =>
  (await as(who, (q) => q("select public.ai_begin($1::uuid, $2::text, $3::integer) as r", [workspace, kind, global])))[0].r as Record<string, any>;
const finish = (who: string, usage: number, key: string, tokens: number, ok = true) =>
  as(who, (q) => q("select public.ai_finish($1::bigint, $2::uuid, $3::integer, $4::boolean)", [usage, key, tokens, ok]));
const report = async (who: string, workspace = ws) => (await as(who, (q) => q("select public.ai_usage_report($1::uuid) as r", [workspace])))[0].r as Record<string, any>;
const setPolicy = (data: Record<string, unknown>) =>
  as("olivia", (q) =>
    q(
      "insert into public.ai_policies (workspace_id, id, data) values ($1, 'workspace', $2) on conflict (workspace_id, id) do update set data = excluded.data",
      [ws, { id: "workspace", updatedAt: new Date().toISOString(), ...data }],
    ),
  );
/** Moves a person's use back in time, as if it happened earlier. */
const age = (who: string, interval: string) => db.query(`update public.ai_usage set started_at = started_at - interval '${interval}' where user_id = $1`, [ids[who]]);

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

describe("fair use of the AI", () => {
  it("lets members ask within the built-in limits, and only members", async () => {
    const r = await begin("edgar");
    expect(r).toMatchObject({ allowed: true, remaining: { hour: 9, day: 39, tokens: 40000 } });
    await finish("edgar", r.usage, r.key, 1200);
    expect((await begin("stranger")).reason).toBe("not_member");
    expect((await begin("edgar", "poem")).reason).toBe("bad_request");
    const mine = await as("edgar", (q) => q("select tokens, status from public.ai_usage"));
    expect(mine).toEqual([{ tokens: 1200, status: "ok" }]);
  });

  it("keeps the key to close a request from the person, and tokens only go up", async () => {
    const r = await begin("edgar");
    await expect(as("edgar", (q) => q("select finish_key from public.ai_usage"))).rejects.toThrow(/permission denied/);
    // Someone without the key changes nothing.
    await finish("edgar", r.usage, "00000000-0000-0000-0000-000000000000", 0, false);
    await finish("edgar", r.usage, r.key, 800);
    await finish("edgar", r.usage, r.key, 10, false);
    const row = (await db.query<{ tokens: number; status: string }>("select tokens, status from public.ai_usage where id = $1", [r.usage])).rows[0];
    expect(row).toEqual({ tokens: 800, status: "ok" });
    // Nobody writes the usage table directly.
    await expect(as("edgar", (q) => q("insert into public.ai_usage (workspace_id, user_id, kind) values ($1, $2, 'text')", [ws, ids.edgar]))).rejects.toThrow(/permission denied/);
    await expect(as("edgar", (q) => q("update public.ai_usage set status = 'failed'"))).rejects.toThrow(/permission denied/);
  });

  it("stops a person at the hourly, daily and token limits, and says when to try again", async () => {
    await setPolicy({ perUser: { hour: 3, day: 5, tokensDay: 100000 } });
    expect(await begin("edgar")).toMatchObject({ allowed: true, remaining: { hour: 0 } });
    const refused = await begin("edgar");
    expect(refused).toMatchObject({ allowed: false, reason: "hour" });
    expect(new Date(refused.retryAt).getTime()).toBeGreaterThan(Date.now());
    await age("edgar", "2 hours");
    expect((await begin("edgar")).allowed).toBe(true);
    expect((await begin("edgar")).allowed).toBe(true);
    expect((await begin("edgar")).reason).toBe("day");
    await age("edgar", "1 day");
    await setPolicy({ perUser: { hour: 10, day: 40, tokensDay: 1000 } });
    const big = await begin("edgar");
    await finish("edgar", big.usage, big.key, 1500);
    expect((await begin("edgar")).reason).toBe("tokens");
  });

  it("does not count requests the model failed", async () => {
    await age("edgar", "1 day");
    await setPolicy({ perUser: { hour: 1, day: 40, tokensDay: 100000 } });
    const r = await begin("edgar");
    await finish("edgar", r.usage, r.key, 0, false);
    expect((await begin("edgar")).allowed).toBe(true);
  });

  it("follows the owners' choices: off, who may use it, features, and exceptions per person", async () => {
    await age("edgar", "1 day");
    await setPolicy({ enabled: false });
    expect((await begin("edgar")).reason).toBe("off");
    await setPolicy({ who: "owners" });
    expect((await begin("edgar")).reason).toBe("role");
    expect((await begin("olivia")).allowed).toBe(true);
    await setPolicy({ who: "editors" });
    expect((await begin("vera", "ask")).reason).toBe("role");
    expect((await begin("edgar")).allowed).toBe(true);
    await setPolicy({ features: { text: true, image: false, ask: true } });
    expect((await begin("edgar", "image")).reason).toBe("feature_off");
    await setPolicy({ overrides: { [ids.edgar]: { blocked: true } } });
    expect((await begin("edgar")).reason).toBe("paused");
    await setPolicy({ perUser: { hour: 10, day: 1, tokensDay: 100000 }, overrides: { [ids.vera]: { day: 3 } } });
    expect((await begin("vera", "ask")).allowed).toBe(true);
    expect((await begin("vera", "ask")).allowed).toBe(true);
    // Only owners set the limits.
    await expect(as("edgar", (q) => q("insert into public.ai_policies (workspace_id, id, data) values ($1, 'workspace', '{\"id\":\"workspace\"}') on conflict do nothing returning id", [ws]))).rejects.toThrow(/row-level security/);
  });

  it("stops the whole workspace at its own limits, scenarios included, and everyone at the server's", async () => {
    await age("edgar", "1 day");
    await age("vera", "1 day");
    await age("olivia", "1 day");
    await setPolicy({ perUser: { hour: 10, day: 40, tokensDay: 100000 }, workspace: { day: 2, tokensDay: 100000 } });
    const scenario = (await as("olivia", (q) => q("select public.create_scenario($1, 'Target', '') as id", [ws])))[0].id;
    expect((await begin("edgar")).allowed).toBe(true);
    expect((await begin("olivia", "text", scenario)).allowed).toBe(true);
    expect((await begin("vera", "ask")).reason).toBe("workspace");
    await setPolicy({ workspace: { day: 100, tokensDay: 100000 } });
    expect((await begin("vera", "ask", ws, 1)).reason).toBe("global");
  });

  it("reports each person's own use, and use by person and by day to owners", async () => {
    const mine = await report("edgar");
    expect(mine.me).toMatchObject({ day: 1, limits: { day: 40, paused: false } });
    expect(mine.people).toBeNull();
    const owner = await report("olivia");
    expect(owner.people.map((p: any) => p.name).sort()).toEqual(["edgar", "olivia", "vera"]);
    expect(owner.people.find((p: any) => p.name === "edgar").month).toBeGreaterThan(5);
    expect(owner.days).toHaveLength(14);
    expect(owner.workspace.limits).toEqual({ day: 100, tokensDay: 100000 });
    expect(await report("stranger")).toBeNull();
    // A person reads only their own rows; an owner reads the workspace's.
    expect(new Set((await as("vera", (q) => q("select user_id from public.ai_usage"))).map((r) => r.user_id))).toEqual(new Set([ids.vera]));
    expect((await as("olivia", (q) => q("select count(distinct user_id)::int as n from public.ai_usage where workspace_id = $1", [ws])))[0].n).toBe(3);
  });

  it("does not stop owners unless the owners choose so, and still counts their use", async () => {
    await age("olivia", "2 days");
    await age("edgar", "2 days");
    await age("vera", "2 days");
    await setPolicy({ perUser: { hour: 1, day: 1, tokensDay: 10 }, workspace: { day: 1, tokensDay: 10 } });
    const first = await begin("olivia");
    expect(first).toMatchObject({ allowed: true, unlimited: true });
    expect(first.remaining).toBeUndefined();
    await finish("olivia", first.usage, first.key, 5000);
    expect((await begin("olivia", "ask")).allowed).toBe(true);
    // The owner's use counts for the workspace, so the others meet its limit.
    expect((await begin("edgar")).reason).toBe("workspace");
    // The server's daily cap for a shared key holds for owners too.
    expect((await begin("olivia", "text", ws, 1)).reason).toBe("global");
    const mine = await report("olivia");
    expect(mine.me).toMatchObject({ day: 2, tokensDay: 5000, limits: { unlimited: true } });
    expect(mine.people.find((p: any) => p.name === "olivia").limits.unlimited).toBe(true);
    expect(mine.people.find((p: any) => p.name === "edgar").limits.unlimited).toBe(false);
    expect((await report("edgar")).me.limits.unlimited).toBe(false);
    // Switched off, owners have the same limits as everyone.
    await setPolicy({ perUser: { hour: 1, day: 1, tokensDay: 10 }, workspace: { day: 100, tokensDay: 100000 }, ownersUnlimited: false });
    expect((await begin("olivia")).reason).toBe("hour");
    expect((await report("olivia")).me.limits.unlimited).toBe(false);
  });

  it("records each change of the limits in the audit log", async () => {
    const log = (await db.query<{ action: string }>("select action from public.audit_log where workspace_id = $1 and action = 'AI limits changed'", [ws])).rows;
    expect(log.length).toBeGreaterThan(5);
  });
});
