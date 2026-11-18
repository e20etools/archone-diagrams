import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/** Approving diagrams and verified copies (PGlite): who may decide, what a decision binds to, what goes out. */

const dir = (path: string) => fileURLToPath(new URL(`../../../supabase/${path}`, import.meta.url));
let db: PGlite;
const ids: Record<string, string> = {};
let ws = "";

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
async function as<T>(who: string | null, run: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [who ? JSON.stringify({ sub: ids[who], email: `${who}@example.com` }) : ""]);
    await tx.exec(who ? "set local role authenticated" : "set local role anon");
    return run(async (sql, params) => (await tx.query(sql, params)).rows as Record<string, any>[]);
  }) as Promise<T>;
}
const one = async (who: string | null, sql: string, params: unknown[] = []) => (await as(who, (q) => q(sql, params)))[0]?.r;
const record = (who = "edgar") => one(who, "select public.diagram_record($1, 'dia_1') as r", [ws]);
const submit = (who: string, note = "") => one(who, "select public.submit_diagram_for_approval($1, 'dia_1', $2) as r", [ws, note]);
const decide = (who: string, role: string, decision: string, note = "") => one(who, "select public.decide_diagram_approval($1, 'dia_1', $2, $3, $4) as r", [ws, role, decision, note]);
const edit = (sql: string) => as("edgar", (q) => q(sql, [ws]));
const view = (token: string) => one(null, "select public.publication_view($1) as r", [token]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "erin", "vera", "sam", "stranger"]) {
    ids[who] = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [`${who}@example.com`, { display_name: who[0].toUpperCase() + who.slice(1) }])).rows[0].id;
  }
  ws = (await as("olivia", (q) => q("select public.create_workspace('Bank') as id")))[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'editor'), ($1, $4, 'viewer'), ($1, $5, 'commenter')", [ws, ids.edgar, ids.erin, ids.vera, ids.sam]);
  await edit("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'obj_a', 'application', 'Portal'), ($1, 'obj_b', 'database', 'Orders DB'), ($1, 'obj_c', 'service', 'Elsewhere')");
  await edit("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'rel_1', 'obj_a', 'obj_b', 'reads_writes'), ($1, 'rel_2', 'obj_a', 'obj_c', 'calls')");
  await as("edgar", (q) => q("insert into public.diagrams (workspace_id, id, name, view_type, created_by) values ($1, 'dia_1', 'Online store', 'container', $2)", [ws, ids.vera]));
  await edit("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'dia_1', 'obj_a', 0, 0), ($1, 'dia_1', 'obj_b', 300, 0)");
}, 60_000);

describe("diagrams made before this", () => {
  it("get their maker from the audit log, without moving when they were last changed", async () => {
    const old = new PGlite();
    await old.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
    const files = readdirSync(dir("migrations")).sort();
    const last = files.findIndex((f) => f.includes("_phase4_diagram_approvals"));
    for (const file of files.slice(0, last)) await old.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
    const maker = (await old.query<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ('maker@example.com', now()) returning id")).rows[0].id;
    const changed = await old.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: maker, email: "maker@example.com" })]);
      await tx.exec("set local role authenticated");
      const wsId = (await tx.query<{ id: string }>("select public.create_workspace('Old') as id")).rows[0].id;
      await tx.query("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'dia_old', 'Old diagram', 'container')", [wsId]);
      return (await tx.query<{ changed_at: string }>("select changed_at::text from public.diagrams where id = 'dia_old'")).rows[0].changed_at;
    });
    for (const file of files.slice(last)) await old.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
    const after = (await old.query<{ created_by: string; changed_at: string }>("select created_by, changed_at::text from public.diagrams where id = 'dia_old'")).rows[0];
    expect(after).toEqual({ created_by: maker, changed_at: changed });
    await old.close();
  }, 60_000);
});

describe("the information box", () => {
  it("knows who made the diagram, whatever the app sends, and who changed it last", async () => {
    const r = await record("vera");
    expect(r).toMatchObject({ created: { by: "Edgar" }, changed: { by: "Edgar" }, status: "draft", version: 1, approvedVersion: null, required: false });
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await as("olivia", (q) => q("update public.diagrams set created_by = $2, description = 'x' where workspace_id = $1 and id = 'dia_1'", [ws, ids.olivia]));
    const after = await record();
    expect(after.created.by).toBe("Edgar");
    expect(after.changed.by).toBe("Olivia");
    await expect(record("stranger")).rejects.toThrow(/Not a member/);
  });

  it("moves its fingerprint with what the diagram shows, and only with that", async () => {
    const before = (await record()).fingerprint;
    await edit("update public.objects set name = 'Elsewhere 2' where workspace_id = $1 and id = 'obj_c'");
    await edit("update public.diagram_nodes set x = 0.3 where workspace_id = $1 and object_id = 'obj_a'");
    await edit(`update public.diagrams set title_block = '{"show": true, "corner": "top-left", "company": "Gulf Bank"}' where workspace_id = $1 and id = 'dia_1'`);
    expect((await record()).fingerprint).toBe(before);
    await edit("update public.diagram_nodes set x = 40 where workspace_id = $1 and object_id = 'obj_a'");
    const moved = (await record()).fingerprint;
    expect(moved).not.toBe(before);
    await edit("update public.objects set name = 'Customer portal' where workspace_id = $1 and id = 'obj_a'");
    expect((await record()).fingerprint).not.toBe(moved);
    // The box's settings are audited in short, without its logo.
    const audit = (await db.query<{ changes: any }>("select changes from public.audit_log where workspace_id = $1 and action = 'information box changed'", [ws])).rows;
    expect(audit[0].changes).toMatchObject({ shown: true, corner: "top-left", company: "Gulf Bank", logo: false });
  });
});

describe("approval", () => {
  it("is set by owners, with members as approvers in each role", async () => {
    await expect(one("edgar", "select public.set_diagram_approval($1, true, $2, $3) as r", [ws, [ids.erin], [ids.sam]])).rejects.toThrow(/Only an owner/);
    await expect(one("olivia", "select public.set_diagram_approval($1, false, $2, '{}') as r", [ws, [ids.stranger]])).rejects.toThrow(/member/);
    await expect(one("olivia", "select public.set_diagram_approval($1, true, $2, '{}') as r", [ws, [ids.erin]])).rejects.toThrow(/at least one/);
    await expect(submit("edgar")).rejects.toThrow(/name the Enterprise Architecture and Cybersecurity approvers/);
    const settings = await one("olivia", "select public.set_diagram_approval($1, true, $2, $3) as r", [ws, [ids.erin, ids.olivia], [ids.sam]]);
    expect(settings).toMatchObject({ required: true, ea: [{ name: "Erin" }, { name: "Olivia" }], security: [{ id: ids.sam, name: "Sam" }] });
    expect(await one("vera", "select public.diagram_approval_settings($1) as r", [ws])).toEqual(settings);
  });

  it("is asked for by editors; approvers return it with notes, and it is sent again", async () => {
    await expect(submit("vera")).rejects.toThrow(/Only owners and editors/);
    const sent = await submit("edgar", "First version for the bank");
    expect(sent).toMatchObject({ status: "pending", version: 1, request: { requestedBy: "Edgar", round: 1, note: "First version for the bank" }, roles: { ea: { state: "waiting" }, security: { state: "waiting" } } });
    await expect(submit("erin")).rejects.toThrow(/already waiting/);
    await expect(decide("edgar", "ea", "approve")).rejects.toThrow(/Enterprise Architecture approver/);
    await expect(decide("erin", "security", "approve")).rejects.toThrow(/Cybersecurity approver/);
    await expect(decide("sam", "security", "return")).rejects.toThrow(/Say what has to change/);
    expect(await decide("erin", "ea", "approve")).toMatchObject({ status: "pending", roles: { ea: { state: "approved", by: "Erin" }, security: { state: "waiting" } } });
    await expect(decide("erin", "ea", "approve")).rejects.toThrow(/already approved/);
    const back = await decide("sam", "security", "return", "The database is reached without TLS.");
    expect(back).toMatchObject({ status: "returned", roles: { ea: { state: "approved" }, security: { state: "returned", note: "The database is reached without TLS." } } });
    await expect(decide("olivia", "ea", "approve")).rejects.toThrow(/back with its sender/);
    // The sender fixes it: an arrow is labelled, which changes what the diagram says.
    await edit("update public.relationships set protocol = 'TLS' where workspace_id = $1 and id = 'rel_1'");
    const again = await submit("edgar", "TLS on the database link");
    expect(again).toMatchObject({ status: "pending", request: { round: 2, note: "TLS on the database link" }, roles: { ea: { state: "stale" }, security: { state: "waiting" } } });
  });

  it("becomes a version once both roles approve the diagram as it is, also after an approver changed it", async () => {
    await decide("sam", "security", "approve");
    expect((await record()).status).toBe("pending");
    // The EA approver moves a box, then approves: Cybersecurity approved another form, so it asks again.
    await as("erin", (q) => q("update public.diagram_nodes set y = 120 where workspace_id = $1 and object_id = 'obj_b'", [ws]));
    const changed = await decide("erin", "ea", "approve", "Moved the database below the portal");
    expect(changed).toMatchObject({ status: "pending", roles: { ea: { state: "approved", withChanges: true }, security: { state: "stale" } } });
    const done = await decide("sam", "security", "approve");
    expect(done).toMatchObject({ status: "approved", version: 1, approvedVersion: 1, roles: { ea: { state: "approved" }, security: { state: "approved" } } });
    expect(done.approvedFingerprint).toBe(done.fingerprint);
    expect(done.history.map((h: any) => `${h.kind}${h.role ? `:${h.role}` : ""}`)).toEqual([
      "completed", "approved:security", "approved_with_changes:ea", "approved:security", "resubmitted", "returned:security", "approved:ea", "submitted",
    ]);
    await expect(submit("edgar")).rejects.toThrow(/approved as it is/);
    const audit = (await db.query<{ action: string }>("select action from public.audit_log where workspace_id = $1 and entity = 'diagram' and (action like '%approv%' or action like '%returned%' or action like 'sent%') order by id", [ws])).rows.map((a) => a.action);
    expect(audit).toEqual([
      "sent for approval", "approved by Enterprise Architecture", "returned for changes by Cybersecurity", "sent for approval again",
      "approved by Cybersecurity", "changed and approved by Enterprise Architecture", "approved by Cybersecurity", "approved as version 1",
    ]);
    // Nobody writes a request or a decision directly, owners included.
    await expect(as("olivia", (q) => q("update public.diagram_approval_requests set status = 'approved'"))).rejects.toThrow(/permission denied/);
    await expect(as("olivia", (q) => q("select * from public.diagram_approval_events"))).rejects.toThrow(/permission denied/);
    expect((await as("vera", (q) => q("select status from public.diagram_approval_requests")))[0].status).toBe("approved");
  });

  it("lapses with any change; the next version starts, can be rejected, and is withdrawn by its sender", async () => {
    await edit("update public.objects set technology = 'React' where workspace_id = $1 and id = 'obj_a'");
    expect(await record()).toMatchObject({ status: "changed", version: 2, approvedVersion: 1, roles: { ea: { state: "stale" }, security: { state: "stale" } } });
    expect(await submit("edgar")).toMatchObject({ status: "pending", version: 2 });
    expect(await decide("olivia", "ea", "reject", "Not this quarter")).toMatchObject({ status: "rejected", version: 2, roles: { ea: { state: "rejected" } } });
    expect(await submit("edgar")).toMatchObject({ status: "pending", version: 2, request: { round: 1 } });
    await expect(one("erin", "select public.withdraw_diagram_approval($1, 'dia_1') as r", [ws])).rejects.toThrow(/Only the person who sent it/);
    expect(await one("edgar", "select public.withdraw_diagram_approval($1, 'dia_1') as r", [ws])).toMatchObject({ status: "changed", version: 2, approvedVersion: 1 });
    const queue = await one("sam", "select public.diagram_approval_queue($1) as r", [ws]);
    expect(queue.mine).toEqual({ ea: false, security: true });
    expect(queue.open).toEqual([]);
    expect(queue.recent.map((r: any) => r.status)).toEqual(["withdrawn", "rejected", "approved"]);
    await submit("erin", "React front end");
    const waiting = await one("sam", "select public.diagram_approval_queue($1) as r", [ws]);
    expect(waiting.open).toEqual([expect.objectContaining({ name: "Online store", version: 2, requestedBy: "Erin", ea: expect.objectContaining({ state: "waiting" }) })]);
  });
});

describe("what goes out", () => {
  let token = "";
  let id = "";
  it("while approval is compulsory: the last approved version, in live links and verified copies", async () => {
    await expect(one("vera", "select public.publish_diagram($1, 'dia_1') as r", [ws])).rejects.toThrow(/Only owners and editors/);
    await expect(one("edgar", "select public.publish_diagram($1, 'dia_1', now() + interval '2 years') as r", [ws])).rejects.toThrow(/a year/);
    await db.query("insert into public.workspace_branding (workspace_id, id, data) values ($1, 'workspace', $2)", [ws, { id: "workspace", company: "Gulf Bank", boxFields: ["version"], updatedAt: "2026-11-18T00:00:00Z" }]);
    const made = await one("edgar", "select public.publish_diagram($1, 'dia_1', now() + interval '2 hours', 'For the auditors') as r", [ws]);
    token = made.token;
    id = made.id;
    expect(made).toMatchObject({ version: 1 });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const v = await view(token);
    expect(v).toMatchObject({ status: "ok", publishedBy: "Edgar", note: "For the auditors", version: 1, current: "changed", latestVersion: 1 });
    // The copy is version 1 as approved: the portal had no technology then, and the box was frozen with it.
    expect(v.record).toMatchObject({ name: "Online store", status: "approved", version: 1, created: { by: "Edgar" }, roles: { ea: { state: "approved", by: "Erin", withChanges: true }, security: { state: "approved", by: "Sam" } } });
    expect(v.record.approvers).toBeUndefined();
    const portal = v.snapshot.objects.find((o: any) => o.id === "obj_a");
    expect(portal).toMatchObject({ name: "Customer portal", technology: "" });
    expect(v.snapshot.relationships.map((r: any) => r.id).sort()).toEqual(["rel_1"]);
    expect(v.snapshot.diagram.created_by).toBeUndefined();
    const embed = await one("edgar", "select public.create_embed($1, 'dia_1') as r", [ws]);
    const live = await one(null, "select public.embed_view($1) as r", [embed]);
    expect(live).toMatchObject({ status: "ok", source: "approved", version: 1, box: { name: "Online store", status: "approved", company: "Gulf Bank", show: true } });
    expect(live.objects.find((o: any) => o.id === "obj_a").technology).toBe("");
  });

  it("without compulsory approval: the diagram as it is, with its box as it reads now", async () => {
    await one("olivia", "select public.set_diagram_approval($1, false, $2, $3) as r", [ws, [ids.erin, ids.olivia], [ids.sam]]);
    const made = await one("edgar", "select public.publish_diagram($1, 'dia_1') as r", [ws]);
    expect(made.version).toBeNull();
    const v = await view(made.token);
    expect(v).toMatchObject({ current: "same", version: null, record: { status: "pending", version: 2, company: "Gulf Bank", requiredFields: ["version"], corner: "top-left", show: true } });
    expect(v.snapshot.objects.find((o: any) => o.id === "obj_a").technology).toBe("React");
    const live = await one(null, "select public.embed_view($1) as r", [(await db.query<{ token: string }>("select token from public.embeds where workspace_id = $1", [ws])).rows[0].token]);
    expect(live).toMatchObject({ source: "working", box: { status: "pending" } });
  });

  it("take file fingerprints, count their views, stop at their end or when switched off", async () => {
    await one("edgar", "select public.add_publication_file($1, $2, $3, 'online-store.png') as r", [ws, id, "b".repeat(64)]);
    await expect(one("vera", "select public.add_publication_file($1, $2, $3, 'x') as r", [ws, id, "c".repeat(64)])).rejects.toThrow(/Only owners and editors/);
    expect((await view(token)).files).toEqual([expect.objectContaining({ sha256: "b".repeat(64), name: "online-store.png" })]);
    const listed = await one("edgar", "select public.list_publications($1, 'dia_1') as r", [ws]);
    expect(listed.at(-1)).toMatchObject({ id, views: 2, files: 1, current: false, createdBy: "Edgar", version: 1 });
    expect(await one("vera", "select public.list_publications($1, 'dia_1') as r", [ws])).toEqual([]);
    // Nobody reads the table directly: the link is the only way in.
    await expect(as("edgar", (q) => q("select * from public.diagram_publications"))).rejects.toThrow(/permission denied/);
    expect((await view("0".repeat(64))).status).toBe("gone");
    await db.query("update public.diagram_publications set expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect(await view(token)).toMatchObject({ status: "expired", name: "Online store" });
    await db.query("update public.diagram_publications set expires_at = null where id = $1", [id]);
    await expect(one("vera", "select public.revoke_publication($1, $2) as r", [ws, id])).rejects.toThrow(/may not switch it off/);
    await one("edgar", "select public.revoke_publication($1, $2) as r", [ws, id]);
    expect((await view(token)).status).toBe("gone");
  });
});
