import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/** Integrations (PGlite): owners set them, secrets go to the vault and never come back to a browser. */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let ws = "";

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string, run: (q: Q) => Promise<T>, role = "authenticated"): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids[who], email: `${who}@example.com` })]);
    await tx.exec(`set local role ${role}`);
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}
const save = (who: string, provider: string, settings: object, secrets: object, workspace = ws) =>
  as(who, (q) => q("select public.integration_save($1::uuid, $2::text, $3::jsonb, $4::jsonb, true)", [workspace, provider, settings, secrets]));
const list = async (who: string, workspace = ws) => (await as(who, (q) => q("select public.integration_list($1::uuid) as r", [workspace])))[0].r as Record<string, any>[];
const credentials = async (provider: string, workspace = ws) => (await as("olivia", (q) => q("select public.integration_credentials($1::uuid, $2::text) as r", [workspace, provider]), "service_role"))[0].r as Record<string, any>;

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

describe("integrations", () => {
  it("lets only owners connect a service, and keeps its secrets in the vault", async () => {
    await save("olivia", "servicenow", { url: "https://acme.service-now.com", user: "svc" }, { password: "pw-1" });
    await expect(save("edgar", "servicenow", { url: "https://evil.example" }, {})).rejects.toThrow(/Only an owner/);
    await expect(save("olivia", "dropbox", {}, {})).rejects.toThrow(/Unknown integration/);
    await expect(save("olivia", "aws", { regions: 42 }, {})).rejects.toThrow(/not valid/);
    const [row] = await list("olivia");
    expect(row).toMatchObject({ provider: "servicenow", settings: { url: "https://acme.service-now.com", user: "svc" }, secretFields: ["password"], status: "untested" });
    expect(JSON.stringify(row)).not.toContain("pw-1");
    // The vault holds it; the table holds only a reference.
    expect((await db.query<{ n: number }>("select count(*)::int as n from vault.secrets where secret like '%pw-1%'")).rows[0].n).toBe(1);
  });

  it("shows editors how it is set up, viewers only that it is there, and nobody else anything", async () => {
    expect((await list("edgar"))[0].settings.url).toBe("https://acme.service-now.com");
    expect((await list("vera"))[0]).toMatchObject({ provider: "servicenow", settings: {}, secretFields: [] });
    await expect(list("stranger")).rejects.toThrow(/Not a member/);
    // Nobody reads the table or the vault directly.
    await expect(as("olivia", (q) => q("select * from public.integrations"))).rejects.toThrow(/permission denied/);
    await expect(as("olivia", (q) => q("select * from vault.decrypted_secrets"))).rejects.toThrow(/permission denied/);
  });

  it("keeps a secret when the form leaves it empty, replaces it when given, and removes it with null", async () => {
    await save("olivia", "servicenow", { url: "https://acme.service-now.com", user: "svc" }, { password: "", token: "tok-1" });
    expect((await credentials("servicenow")).secrets).toEqual({ password: "pw-1", token: "tok-1" });
    await save("olivia", "servicenow", { url: "https://acme.service-now.com" }, { password: null, token: "tok-2" });
    expect(await credentials("servicenow")).toEqual({ enabled: true, settings: { url: "https://acme.service-now.com" }, secrets: { token: "tok-2" } });
    expect((await list("olivia"))[0].secretFields).toEqual(["token"]);
  });

  it("gives the secrets back only to the server, which records how the connection went", async () => {
    await expect(as("olivia", (q) => q("select public.integration_credentials($1::uuid, 'servicenow')", [ws]))).rejects.toThrow(/permission denied/);
    await expect(as("olivia", (q) => q("select public.integration_mark($1::uuid, 'servicenow', true, 'x')", [ws]))).rejects.toThrow(/permission denied/);
    await as("olivia", (q) => q("select public.integration_mark($1::uuid, 'servicenow', false, 'ServiceNow did not accept the credentials.')", [ws]), "service_role");
    expect((await list("edgar"))[0]).toMatchObject({ status: "failed", statusMessage: "ServiceNow did not accept the credentials." });
    // Saving again starts afresh.
    await save("olivia", "servicenow", { url: "https://acme.service-now.com" }, {});
    expect((await list("edgar"))[0].status).toBe("untested");
  });

  it("writes changes to the audit log without the secrets", async () => {
    const entries = (await db.query<{ action: string; changes: object }>("select action, changes from public.audit_log where workspace_id = $1 and action like 'Integration%' order by id", [ws])).rows;
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(entries)).not.toMatch(/pw-1|tok-1|tok-2/);
    expect(entries[0].changes).toMatchObject({ provider: "servicenow", secretFields: ["password"] });
  });

  it("tells members which AI the workspace uses, and lets each counted request through once", async () => {
    await save("olivia", "ai", { provider: "groq", model: "llama-3.3-70b-versatile" }, { apiKey: "gsk-test" });
    await expect(save("olivia", "dropbox", {}, {})).rejects.toThrow(/Unknown integration/);
    const ai = (await as("vera", (q) => q("select public.ai_integration($1::uuid) as r", [ws])))[0].r;
    expect(ai).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile", visionModel: "" });
    expect((await as("stranger", (q) => q("select public.ai_integration($1::uuid) as r", [ws])))[0].r).toBeNull();
    const begun = (await as("edgar", (q) => q("select public.ai_begin($1::uuid, 'text', 0) as r", [ws])))[0].r as { usage: number; key: string };
    const use = (who: string, key = begun.key) => as(who, async (q) => (await q("select public.ai_ticket_use($1::uuid, $2::bigint, $3::uuid) as ok", [ws, begun.usage, key]))[0].ok as boolean);
    expect(await use("vera")).toBe(false);
    expect(await use("edgar", "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(await use("edgar")).toBe(true);
    expect(await use("edgar")).toBe(false);
  });

  it("removes the integration and its secret, and owners only", async () => {
    await expect(as("edgar", (q) => q("select public.integration_remove($1::uuid, 'servicenow')", [ws]))).rejects.toThrow(/Only an owner/);
    await as("olivia", (q) => q("select public.integration_remove($1::uuid, 'servicenow')", [ws]));
    await as("olivia", (q) => q("select public.integration_remove($1::uuid, 'ai')", [ws]));
    expect(await list("olivia")).toEqual([]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from vault.secrets")).rows[0].n).toBe(0);
  });
});
