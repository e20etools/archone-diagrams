import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHandler } from "../api/http";
import { gateMarkdown, gateProposal, readDeclarations, runGate } from "./gate";

/**
 * The pull-request gate. The rules are tested as plain functions; then the bundled script is
 * run as a repository's CI would run it, against the real API handler and database rules.
 */

const model = {
  objects: [
    { id: "o1", name: "Orders service", typeId: "service", owner: "Digital", lifecycle: "active", fields: {} },
    { id: "o2", name: "Orders database", typeId: "database", owner: "Digital", lifecycle: "active", fields: {} },
    { id: "o3", name: "Old gateway", typeId: "gateway", owner: "Platform", lifecycle: "retired", fields: {} },
    { id: "o4", name: "Mailer", typeId: "external-system", owner: "", lifecycle: "active", fields: {} },
  ],
  relationships: [{ id: "r1", sourceId: "o1", targetId: "o2", kind: "reads_writes", protocol: "TLS" }],
};

describe("the gate's rules", () => {
  it("reads the declaration and says what is wrong with a bad one", () => {
    expect(readDeclarations('{"system":" Orders service ","connections":[{"to":"Orders database","protocol":"TLS"}]}')).toEqual({ declarations: [{ system: "Orders service", connections: [{ to: "Orders database", protocol: "TLS", kind: undefined, why: "" }] }], problems: [] });
    expect(readDeclarations('{"systems":[{"system":"A","connections":[]},{"system":"B","connections":[{"to":"C","kind":"flows_to"}]}]}').declarations).toHaveLength(2);
    expect(readDeclarations("{nope").problems).toEqual(["The declaration file is not valid JSON."]);
    expect(readDeclarations('{"connections":[]}').problems[0]).toContain('needs "system"');
    expect(readDeclarations('{"system":"A"}').problems[0]).toContain('needs "connections"');
    expect(readDeclarations('{"system":"A","connections":[{"protocol":"x"},{"to":"B","kind":"marries"}]}').problems).toHaveLength(2);
  });

  it("passes what the model agrees to, stops what a rule forbids, and reports what the model does not know", () => {
    const { declarations } = readDeclarations(JSON.stringify({ system: "Orders service", connections: [{ to: "Orders database", protocol: "TLS" }, { to: "Old gateway" }, { to: "Mailer", protocol: "HTTPS", kind: "flows_to" }, { to: "Nowhere" }] }));
    const report = runGate(model, declarations);
    expect(report.rows.map((r) => r.answer)).toEqual(["yes", "no", "unknown", "unknown"]);
    expect(report.counts).toEqual({ yes: 1, no: 1, unknown: 2 });
    expect(report.failed).toBe(true);
    expect(report.rows[2].proposable).toEqual({ sourceId: "o1", targetId: "o4", kind: "flows_to", protocol: "HTTPS" });
    expect(report.rows[3].proposable).toBeNull();
    const allowed = runGate(model, [{ system: "o1", connections: [{ to: "o2" }, { to: "Mailer" }] }]);
    expect(allowed.failed).toBe(false);
    expect(runGate(model, [{ system: "o1", connections: [{ to: "Mailer" }] }], { unknown: "fail" }).failed).toBe(true);
    expect(gateProposal(report, "https://github.com/acme/orders/pull/7")).toEqual({ title: "Connections declared by Orders service", notes: "Declared in a pull request and not yet in the model. Source: https://github.com/acme/orders/pull/7.", relationships: [{ sourceKey: "o1", targetKey: "o4", kind: "flows_to", protocol: "HTTPS" }] });
    expect(gateProposal(runGate(model, [{ system: "o1", connections: [{ to: "o2" }] }]), "")).toBeNull();
    const text = gateMarkdown(report, { filed: true, id: "prop_1" });
    expect(text).toContain("1 agreed, 1 not allowed, 2 not known to the model.");
    expect(text).toContain("| Orders service | Old gateway | not stated | No | No. Old gateway is retired. Nothing should depend on it. |");
    expect(text).toContain("filed as a proposal (prop_1)");
    expect(text).toContain("**The gate did not pass.**");
  });
});

describe("the gate as a repository runs it", () => {
  const dir = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
  let db: PGlite;
  let server: Server;
  let base = "";
  const keys: Record<string, string> = {};
  const work = mkdtempSync(join(tmpdir(), "archone-gate-"));

  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string }>((done) => {
      execFile(process.execPath, [dir("gate/archone-gate.mjs"), ...args], { cwd: work, env: { PATH: process.env.PATH ?? "", ARCHONE_API_URL: base, ARCHONE_API_KEY: keys.read, ...env } }, (error, stdout) => done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout }));
    });

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(readFileSync(dir("supabase/tests/supabase-shim.sql"), "utf8"));
    for (const file of readdirSync(dir("supabase/migrations")).sort()) await db.exec(readFileSync(dir(`supabase/migrations/${file}`), "utf8"));
    const owner = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ('olivia@example.com', now()) returning id")).rows[0].id;
    let ws = "";
    await db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner })]);
      await tx.exec("set local role authenticated");
      ws = (await tx.query<{ id: string }>("select public.create_workspace('Shop') as id")).rows[0].id;
      for (const access of ["read", "propose"]) keys[access] = (await tx.query<{ key: string }>("select * from public.create_api_key($1, $2, $3)", [ws, `Gate ${access}`, access])).rows[0].key;
      await tx.query(
        `insert into public.objects (workspace_id, id, type_id, name, owner, lifecycle) values
          ($1, 'o1', 'service', 'Orders service', 'Digital', 'active'), ($1, 'o2', 'database', 'Orders database', 'Digital', 'active'),
          ($1, 'o3', 'gateway', 'Old gateway', 'Platform', 'retired'), ($1, 'o4', 'external-system', 'Mailer', '', 'active')`,
        [ws],
      );
      await tx.query("insert into public.relationships (workspace_id, id, source_id, target_id, kind, protocol) values ($1, 'r1', 'o1', 'o2', 'reads_writes', 'TLS')", [ws]);
    });
    const upstream = async (_input: string, init?: RequestInit): Promise<Response> => {
      const args = JSON.parse(String(init?.body ?? "{}"));
      const reply = await db.transaction(async (tx) => {
        await tx.query("select set_config('request.jwt.claims', '', true)");
        await tx.exec("set local role anon");
        return (await tx.query<{ reply: unknown }>("select public.api_request($1, $2, $3, $4, $5) as reply", [args.p_key, args.p_method, args.p_path, JSON.stringify(args.p_query), args.p_body === null ? null : JSON.stringify(args.p_body)])).rows[0].reply;
      });
      return new Response(JSON.stringify(reply), { status: 200 });
    };
    const handler = createApiHandler(() => ({ SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon" }), upstream);
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/functions/v1/api/v1`;
  }, 60_000);
  afterAll(() => server?.close());

  it("passes a declaration the model agrees with", async () => {
    writeFileSync(join(work, "archone.json"), JSON.stringify({ system: "Orders service", connections: [{ to: "Orders database", protocol: "TLS" }] }));
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("| Orders service | Orders database | TLS | Yes |");
    expect(result.out).toContain("**The gate passed.**");
  }, 30_000);

  it("fails on a connection a rule forbids, and writes the summary where the CI shows it", async () => {
    writeFileSync(join(work, "bad.json"), JSON.stringify({ system: "Orders service", connections: [{ to: "Old gateway" }, { to: "Mailer", protocol: "HTTPS" }] }));
    const summary = join(work, "summary.md");
    const result = await run(["--file", "bad.json"], { GITHUB_STEP_SUMMARY: summary });
    expect(result.code).toBe(1);
    expect(readFileSync(summary, "utf8")).toContain("0 agreed, 1 not allowed, 1 not known to the model.");
    // Unknown alone warns by default and fails when asked to.
    writeFileSync(join(work, "new.json"), JSON.stringify({ system: "Orders service", connections: [{ to: "Mailer", protocol: "HTTPS" }] }));
    expect((await run(["--file", "new.json"])).code).toBe(0);
    expect((await run(["--file", "new.json", "--unknown", "fail"])).code).toBe(1);
  }, 30_000);

  it("files what the model does not know as a proposal that names the pull request", async () => {
    const env = { ARCHONE_API_KEY: keys.propose, GITHUB_REPOSITORY: "acme/orders", GITHUB_REF: "refs/pull/7/merge" };
    const result = await run(["--file", "new.json", "--propose"], env);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/filed as a proposal \(\S+\)/);
    const { rows } = await db.query<{ status: string; data: { title: string; notes: string; relationships: unknown[] } }>("select status, data from public.proposals");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(JSON.stringify(rows[0].data)).toContain("https://github.com/acme/orders/pull/7");
    expect((await db.query("select 1 from public.relationships where not deleted")).rows).toHaveLength(1);
    // A key that may only read cannot file one; the gate says so and still reports.
    const refused = await run(["--file", "new.json", "--propose"]);
    expect(refused.out).toContain("The proposal could not be filed (status 403)");
  }, 30_000);

  it("stops with a plain reason when it cannot run", async () => {
    expect((await run(["--file", "missing.json"])).code).toBe(2);
    const wrong = await run([], { ARCHONE_API_KEY: "ark_wrong" });
    expect(wrong.code).toBe(2);
    expect(wrong.out).toContain("The model could not be read (status 401)");
    writeFileSync(join(work, "broken.json"), "{");
    expect((await run(["--file", "broken.json"])).out).toContain("not valid JSON");
  }, 30_000);
});
