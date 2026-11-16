import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Comments, versions and review before publishing, checked on a real Postgres (PGlite) as
 * different signed-in people. See database.test.ts for the accounts and workspace rules.
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
const one = async (who: string, sql: string, params?: unknown[]) => (await as(who, (q) => q(sql, params)))[0];
const denied = async (who: string | null, sql: string, params?: unknown[]) => {
  try {
    const rows = await as(who, (q) => q(sql, params));
    return rows.length === 0 ? "nothing" : "allowed";
  } catch (error) {
    return /permission denied|row-level security|42501/i.test(String((error as Error).message)) ? "denied" : `error: ${(error as Error).message}`;
  }
};
const stage = (id: string, name: string, who: string, checklist: string[]) => ({ id, name, reviewerId: ids[who], checklist });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(dir("tests/supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(dir("migrations")).sort()) await db.exec(readFileSync(dir(`migrations/${file}`), "utf8"));
  for (const who of ["olivia", "edgar", "vera", "carl", "stranger"]) {
    const { rows } = await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [
      `${who}@example.com`,
      { display_name: who[0].toUpperCase() + who.slice(1) },
    ]);
    ids[who] = rows[0].id;
  }
  workspace = (await one("olivia", "select public.create_workspace('Payments') as id")).id;
  for (const [who, role] of [["edgar", "editor"], ["vera", "viewer"], ["carl", "commenter"]]) {
    await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspace, ids[who], role]);
  }
  await as("edgar", async (q) => {
    await q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'o1', 'service', 'Ledger'), ($1, 'o2', 'database', 'Ledger DB'), ($1, 'gone', 'service', 'Old')", [workspace]);
    await q("update public.objects set deleted = true where id = 'gone'");
    await q("insert into public.relationships (workspace_id, id, source_id, target_id, kind) values ($1, 'r1', 'o1', 'o2', 'reads_writes')", [workspace]);
    await q("insert into public.diagrams (workspace_id, id, name, view_type) values ($1, 'd1', 'Overview', 'landscape')", [workspace]);
    await q("insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y) values ($1, 'd1', 'o1', 10, 20), ($1, 'd1', 'o2', 10, 200)", [workspace]);
  });
}, 60_000);

describe("comments", () => {
  let thread = "";

  it("lets owners, editors and commenters write, and nobody else", async () => {
    const add = "insert into public.comments (workspace_id, diagram_id, target_kind, target_id, body, mentions) values ($1, 'd1', 'object', 'o1', $2, $3) returning id, author_id, resolved";
    const row = await one("carl", add, [workspace, "Is this still the system of record?", [ids.edgar]]);
    thread = row.id;
    expect(row.author_id).toBe(ids.carl);
    expect(await denied("vera", add, [workspace, "A viewer's note", []])).toBe("denied");
    expect(await denied("stranger", add, [workspace, "An outsider's note", []])).toBe("denied");
    expect(await denied(null, "select * from public.comments")).toBe("denied");
    expect(await denied("stranger", "select * from public.comments")).toBe("nothing");
    expect((await as("vera", (q) => q("select body from public.comments"))).length).toBe(1);
  });

  it("records the real author whatever the request claims", async () => {
    const row = await one("edgar", "insert into public.comments (workspace_id, target_kind, target_id, body, author_id, resolved) values ($1, 'diagram', 'd1', 'Mine', $2, true) returning author_id, resolved", [workspace, ids.olivia]);
    expect(row).toEqual({ author_id: ids.edgar, resolved: false });
  });

  it("keeps a reply on its thread's target and refuses replies to replies", async () => {
    const reply = await one("edgar", "insert into public.comments (workspace_id, target_kind, target_id, parent_id, body) values ($1, 'diagram', 'elsewhere', $2, 'Yes, until Q3.') returning id, target_kind, target_id, diagram_id", [workspace, thread]);
    expect(reply).toMatchObject({ target_kind: "object", target_id: "o1", diagram_id: "d1" });
    await expect(as("carl", (q) => q("insert into public.comments (workspace_id, target_kind, target_id, parent_id, body) values ($1, 'object', 'o1', $2, 'Nested')", [workspace, reply.id]))).rejects.toThrow(/no longer exists/);
  });

  it("lets only the author change the text, anyone who comments resolve, and the author or an owner delete", async () => {
    await expect(as("edgar", (q) => q("update public.comments set body = 'Rewritten' where id = $1", [thread]))).rejects.toThrow(/Only its author/);
    const edited = await one("carl", "update public.comments set body = 'Is this the system of record?' where id = $1 returning edited_at", [thread]);
    expect(edited.edited_at).not.toBeNull();
    expect(await one("edgar", "update public.comments set resolved = true where id = $1 returning resolved_by", [thread])).toEqual({ resolved_by: ids.edgar });
    expect(await denied("vera", "update public.comments set resolved = false where id = $1 returning id", [thread])).toBe("nothing");
    await expect(as("edgar", (q) => q("update public.comments set deleted = true where id = $1", [thread]))).rejects.toThrow(/author or an owner/);
    expect(await denied("olivia", "update public.comments set deleted = true where id = $1 returning id", [thread])).toBe("allowed");
    expect(await denied("carl", "delete from public.comments where id = $1 returning id", [thread])).toBe("denied");
  });
});

describe("versions", () => {
  let first = "";

  it("copies the saved model, without rows marked deleted, when an editor saves a version", async () => {
    first = (await one("edgar", "select public.save_version($1, '  Before the migration ', 'Quarter end') as id", [workspace])).id;
    const version = await one("edgar", "select name, note, kind, created_by, object_count, relationship_count, diagram_count, snapshot from public.versions where id = $1", [first]);
    expect(version).toMatchObject({ name: "Before the migration", note: "Quarter end", kind: "manual", created_by: ids.edgar, object_count: 2, relationship_count: 1, diagram_count: 1 });
    expect(version.snapshot.objects.map((o: { id: string }) => o.id)).toEqual(["o1", "o2"]);
    expect(version.snapshot.objects[0]).not.toHaveProperty("workspace_id");
    expect(version.snapshot.nodes).toHaveLength(2);
    expect(version.snapshot.relationships[0]).toMatchObject({ source_id: "o1", target_id: "o2", kind: "reads_writes" });
  });

  it("does not change when the model changes afterwards", async () => {
    await as("edgar", (q) => q("update public.objects set name = 'General ledger' where id = 'o1'"));
    const version = await one("edgar", "select snapshot from public.versions where id = $1", [first]);
    expect(version.snapshot.objects[0].name).toBe("Ledger");
  });

  it("is saved only by owners and editors and written only by the database", async () => {
    await expect(as("vera", (q) => q("select public.save_version($1, 'Mine')", [workspace]))).rejects.toThrow(/Only owners and editors/);
    await expect(as("carl", (q) => q("select public.save_version($1, 'Mine')", [workspace]))).rejects.toThrow(/Only owners and editors/);
    await expect(as("stranger", (q) => q("select public.save_version($1, 'Mine')", [workspace]))).rejects.toThrow(/Only owners and editors/);
    expect(await denied("edgar", "insert into public.versions (workspace_id, name, snapshot, object_count, relationship_count, diagram_count) values ($1, 'Forged', '{}', 0, 0, 0) returning id", [workspace])).toBe("denied");
    expect(await denied("olivia", "update public.versions set name = 'Renamed' returning id")).toBe("denied");
    expect(await denied("edgar", "select public.take_snapshot($1, 'x', '', 'manual')", [workspace])).toBe("denied");
  });

  it("can be read by every member while review is off, and deleted only by an owner", async () => {
    expect((await as("vera", (q) => q("select id from public.versions"))).length).toBe(1);
    expect(await denied("stranger", "select id from public.versions")).toBe("nothing");
    const spare = (await one("olivia", "select public.save_version($1, 'Spare') as id", [workspace])).id;
    expect(await denied("edgar", "delete from public.versions where id = $1 returning id", [spare])).toBe("nothing");
    expect(await denied("olivia", "delete from public.versions where id = $1 returning id", [spare])).toBe("allowed");
  });
});

describe("review before publishing", () => {
  let baseline = "";
  let review = "";
  let candidate = "";
  const settings = (who: string, required: boolean, stages: unknown[]) => as(who, (q) => q("select public.set_review_settings($1, $2, $3)", [workspace, required, JSON.stringify(stages)]));
  const state = async () => one("olivia", "select status, stage_index, decisions, stages from public.reviews where id = $1", [review]);

  it("is set up only by an owner, with real members as reviewers", async () => {
    await expect(settings("edgar", true, [stage("a", "Architecture", "edgar", [])])).rejects.toThrow(/Only an owner/);
    await expect(settings("olivia", true, [])).rejects.toThrow(/at least one review stage/);
    await expect(settings("olivia", true, [stage("a", "Architecture", "stranger", [])])).rejects.toThrow(/member of this workspace/);
    await expect(settings("olivia", true, [stage("a", " ", "edgar", [])])).rejects.toThrow(/name/);
    expect(await denied("olivia", "update public.workspaces set review_required = true returning id")).toBe("denied");
    expect(await denied("olivia", "update public.workspaces set published_version_id = null returning id")).toBe("denied");
    await expect(as("edgar", (q) => q("select public.submit_review($1, 'Too early')", [workspace]))).rejects.toThrow(/switched off/);
  });

  it("publishes the current model as the baseline when review is switched on", async () => {
    await settings("olivia", true, [stage("a", "Architecture", "olivia", ["Follows the reference architecture", "Owners are named"]), stage("s", "Security", "vera", ["No new public endpoints"])]);
    const ws = await one("olivia", "select review_required, review_stages, published_version_id from public.workspaces where id = $1", [workspace]);
    expect(ws.review_required).toBe(true);
    expect(ws.review_stages.map((s: { name: string }) => s.name)).toEqual(["Architecture", "Security"]);
    baseline = ws.published_version_id;
    expect(await one("olivia", "select kind, object_count from public.versions where id = $1", [baseline])).toEqual({ kind: "baseline", object_count: 2 });
  });

  it("then shows people who cannot edit only the published version, not the working model", async () => {
    for (const who of ["vera", "carl"]) {
      for (const table of ["objects", "relationships", "diagrams", "diagram_nodes", "proposals"]) expect(await denied(who, `select * from public.${table}`)).toBe("nothing");
      expect((await as(who, (q) => q("select id from public.versions"))).map((v) => v.id)).toEqual([baseline]);
    }
    expect((await as("edgar", (q) => q("select id from public.objects where not deleted"))).length).toBe(2);
    expect((await as("edgar", (q) => q("select id from public.versions"))).length).toBe(2);
    // Comments stay open to commenters on what they can see.
    expect(await denied("carl", "insert into public.comments (workspace_id, target_kind, target_id, body) values ($1, 'object', 'o2', 'Still here') returning id", [workspace])).toBe("allowed");
  });

  it("takes a submission from an editor, one at a time", async () => {
    await as("edgar", (q) => q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'o3', 'queue', 'Events')", [workspace]));
    await expect(as("vera", (q) => q("select public.submit_review($1, 'Add events')", [workspace]))).rejects.toThrow(/Only owners and editors/);
    review = (await one("edgar", "select public.submit_review($1, 'Add the events queue', 'For the Q3 release') as id", [workspace])).id;
    const row = await one("edgar", "select version_id, base_version_id, status, stage_index, submitted_by from public.reviews where id = $1", [review]);
    candidate = row.version_id;
    expect(row).toMatchObject({ base_version_id: baseline, status: "open", stage_index: 0, submitted_by: ids.edgar });
    expect(await one("edgar", "select kind, object_count from public.versions where id = $1", [candidate])).toEqual({ kind: "review", object_count: 3 });
    await expect(as("edgar", (q) => q("select public.submit_review($1, 'Another')", [workspace]))).rejects.toThrow(/already open/);
    expect(await denied("edgar", "update public.reviews set status = 'approved' returning id")).toBe("denied");
    expect((await as("vera", (q) => q("select id from public.reviews"))).length).toBe(1);
    expect(await denied("stranger", "select id from public.reviews")).toBe("nothing");
  });

  it("lets only the stage's reviewer decide, and only with the checklist ticked", async () => {
    const decide = (who: string, approve: boolean, reason: string, ticks: boolean[]) => as(who, (q) => q("select public.decide_review($1, $2, $3, $4) as status", [review, approve, reason, JSON.stringify(ticks)]));
    await expect(decide("edgar", true, "", [true, true])).rejects.toThrow(/waiting for someone else/);
    await expect(decide("vera", true, "", [true])).rejects.toThrow(/waiting for someone else/);
    await expect(decide("stranger", true, "", [true, true])).rejects.toThrow(/no longer exists/);
    await expect(decide("olivia", true, "", [true, false])).rejects.toThrow(/Tick every item/);
    await expect(decide("olivia", true, "", [true])).rejects.toThrow(/Tick every item/);
    await expect(decide("olivia", false, "  ", [])).rejects.toThrow(/reason/);
    // The second stage's reviewer cannot open the submitted version until the review reaches them.
    expect((await as("vera", (q) => q("select id from public.versions"))).map((v) => v.id)).toEqual([baseline]);
    expect((await decide("olivia", true, "Looks right", [true, true]))[0].status).toBe("open");
    expect(await state()).toMatchObject({ status: "open", stage_index: 1 });
    expect((await as("vera", (q) => q("select id from public.versions order by created_at"))).map((v) => v.id)).toEqual([baseline, candidate]);
    expect((await one("olivia", "select published_version_id as id from public.workspaces where id = $1", [workspace])).id).toBe(baseline);
  });

  it("lets the reviewer or an owner hand a stage to another member", async () => {
    const delegate = (who: string, to: string) => as(who, (q) => q("select public.delegate_review($1, $2)", [review, ids[to]]));
    await expect(delegate("edgar", "carl")).rejects.toThrow(/reviewer or an owner/);
    await expect(delegate("vera", "stranger")).rejects.toThrow(/another member/);
    await expect(delegate("vera", "vera")).rejects.toThrow(/another member/);
    await delegate("vera", "carl");
    const now = await state();
    expect(now.stages[1].reviewerId).toBe(ids.carl);
    expect(now.decisions.map((d: { decision: string }) => d.decision)).toEqual(["approved", "delegated"]);
    expect((await as("vera", (q) => q("select id from public.versions"))).map((v) => v.id)).toEqual([baseline]);
    await delegate("olivia", "vera");
    // The settings still name the original reviewers: only this review changed hands.
    expect((await one("olivia", "select review_stages from public.workspaces where id = $1", [workspace])).review_stages[1].reviewerId).toBe(ids.vera);
  });

  it("closes on a rejection with its reason and leaves the published version as it was", async () => {
    expect((await one("vera", "select public.decide_review($1, false, 'The queue is reachable from the internet', '[]') as status", [review])).status).toBe("rejected");
    const closed = await state();
    expect(closed.status).toBe("rejected");
    expect(closed.decisions.at(-1)).toMatchObject({ decision: "rejected", stageName: "Security", by: ids.vera, reason: "The queue is reachable from the internet" });
    expect((await one("olivia", "select published_version_id as id from public.workspaces where id = $1", [workspace])).id).toBe(baseline);
    await expect(as("vera", (q) => q("select public.decide_review($1, true, '', '[true]')", [review]))).rejects.toThrow(/already closed/);
    expect(await denied("olivia", "delete from public.versions where id = $1 returning id", [candidate])).toBe("nothing");
    expect(await denied("olivia", "delete from public.versions where id = $1 returning id", [baseline])).toBe("nothing");
  });

  it("publishes the submitted version once every stage approves", async () => {
    review = (await one("edgar", "select public.submit_review($1, 'Events queue, internal only') as id", [workspace])).id;
    candidate = (await one("edgar", "select version_id as id from public.reviews where id = $1", [review])).id;
    await as("olivia", (q) => q("select public.decide_review($1, true, '', '[true, true]')", [review]));
    // Work continues on the draft while the review is open; it is not part of what gets published.
    await as("edgar", (q) => q("insert into public.objects (workspace_id, id, type_id, name) values ($1, 'o4', 'service', 'Not reviewed yet')", [workspace]));
    expect((await one("vera", "select public.decide_review($1, true, '', '[true]') as status", [review])).status).toBe("approved");
    expect((await one("olivia", "select published_version_id as id from public.workspaces where id = $1", [workspace])).id).toBe(candidate);
    const seen = await as("vera", (q) => q("select id, snapshot from public.versions"));
    expect(seen.map((v) => v.id)).toEqual([candidate]);
    expect(seen[0].snapshot.objects.map((o: { name: string }) => o.name)).toEqual(["General ledger", "Ledger DB", "Events"]);
  });

  it("lets the submitter or an owner withdraw an open review", async () => {
    review = (await one("edgar", "select public.submit_review($1, 'Third') as id", [workspace])).id;
    await expect(as("vera", (q) => q("select public.withdraw_review($1)", [review]))).rejects.toThrow(/submitted it or an owner/);
    await as("edgar", (q) => q("select public.withdraw_review($1)", [review]));
    expect((await state()).status).toBe("withdrawn");
  });

  it("leaves a decision record for every approval and rejection, and none for a withdrawal", async () => {
    const records = (await as("vera", (q) => q("select status, data from public.decision_records where workspace_id = $1 order by (data ->> 'number')::int", [workspace]))).map((r) => r.data);
    expect(records.map((r) => [r.number, r.status, r.title, r.origin])).toEqual([
      [1, "rejected", "Add the events queue", "review"],
      [2, "accepted", "Events queue, internal only", "review"],
    ]);
    expect(records[0].context).toBe("For the Q3 release");
    expect(records[0].decision).toMatch(/^Rejected in review at the stage ".+" by Vera\. Reason: The queue is reachable from the internet$/);
    expect(records[0].consequences).toMatch(/^Objects: \d+ added, \d+ changed, \d+ removed\. Relationships: \d+ added, \d+ changed, \d+ removed\. The published version stays as it was\.$/);
    expect(records[1].decision).toMatch(/^Approved in review\. .+: Olivia; .+: Vera\.$/);
    expect(records[1].consequences).toMatch(/The reviewed model became the published version\.$/);
    expect(records[1].author).toBe("Edgar");
    expect(records[1].id).toBe(`adr_${String(records[1].reviewId).replace(/-/g, "").slice(0, 12)}`);
    expect(Array.isArray(records[1].objectIds)).toBe(true);
    expect(records[1].decidedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await denied("stranger", "select * from public.decision_records")).toBe("nothing");
    expect(await denied(null, "select * from public.decision_records")).toBe("denied");
  });

  it("counts what a review changed against the version it started from", async () => {
    const diff = async (before: unknown, after: unknown) => (await db.query("select * from public.snapshot_diff($1::jsonb, $2::jsonb)", [JSON.stringify(before), JSON.stringify(after)])).rows[0];
    const a = { id: "a", name: "A", updated_at: "1" };
    expect(await diff([a, { id: "b", name: "B" }, { id: "c", name: "C" }], [{ ...a, updated_at: "2" }, { id: "b", name: "B2" }, { id: "d", name: "D" }])).toEqual({ added: 1, changed: 1, removed: 1, ids: ["b", "d"] });
    expect(await diff(null, [a])).toEqual({ added: 1, changed: 0, removed: 0, ids: ["a"] });
  });

  it("lets editors write decisions and fixes the text once one is decided", async () => {
    const record = (status: string, extra: Record<string, unknown> = {}) => ({ id: "adr_manual", number: 3, title: "Use one queue", status, context: "", decision: "Kafka", consequences: "", objectIds: ["o1"], supersededBy: null, origin: "manual", author: "Edgar", decidedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra });
    const save = (who: string, data: Record<string, unknown>, deleted = false) =>
      as(who, (q) => q("insert into public.decision_records (workspace_id, id, status, data, deleted) values ($1, $2, $3, $4, $5) on conflict (workspace_id, id) do update set status = excluded.status, data = excluded.data, deleted = excluded.deleted", [workspace, data.id, data.status, JSON.stringify(data), deleted]));
    await expect(save("vera", record("proposed"))).rejects.toThrow(/row-level security/);
    await expect(save("carl", record("proposed"))).rejects.toThrow(/row-level security/);
    await save("edgar", record("proposed"));
    await save("edgar", record("proposed", { decision: "Kafka, one cluster" }));
    await expect(save("edgar", record("accepted", { id: "adr_other" }))).resolves.toBeDefined();
    await save("edgar", record("accepted", { decision: "Kafka, one cluster", decidedAt: "2026-01-02T00:00:00.000Z" }));
    await expect(save("edgar", record("accepted", { decision: "RabbitMQ", decidedAt: "2026-01-02T00:00:00.000Z" }))).rejects.toThrow(/text of a decided record is fixed/);
    await expect(save("edgar", record("proposed", { decision: "Kafka, one cluster", decidedAt: "2026-01-02T00:00:00.000Z" }))).rejects.toThrow(/cannot go back to proposed/);
    await expect(save("olivia", record("accepted", { decision: "Kafka, one cluster", decidedAt: "2026-01-02T00:00:00.000Z" }), true)).rejects.toThrow(/cannot be deleted/);
    await save("edgar", record("superseded", { decision: "Kafka, one cluster", decidedAt: "2026-01-02T00:00:00.000Z", supersededBy: "adr_other", objectIds: ["o1", "o2"] }));
    await expect(as("edgar", (q) => q("update public.decision_records set status = 'accepted' where workspace_id = $1 and id = 'adr_manual'", [workspace]))).rejects.toThrow(/check constraint/);
    const log = await as("olivia", (q) => q("select action from public.audit_log where workspace_id = $1 and entity = 'decision' and entity_id = 'adr_manual' order by id", [workspace]));
    expect(log.map((l) => l.action)).toEqual(["created", "updated", "accepted", "superseded"]);
    const fromReviews = await as("olivia", (q) => q("select actor_name, action from public.audit_log where workspace_id = $1 and entity = 'decision' and entity_id <> 'adr_manual' and entity_id <> 'adr_other' order by id", [workspace]));
    expect(fromReviews).toEqual([{ actor_name: "Vera", action: "created" }, { actor_name: "Vera", action: "created" }]);
  });

  it("gives readers the working model back when an owner switches review off", async () => {
    await settings("olivia", false, [stage("a", "Architecture", "olivia", [])]);
    expect((await as("vera", (q) => q("select id from public.objects where not deleted"))).length).toBe(4);
  });

  it("removes versions, reviews and comments with the workspace", async () => {
    expect(await denied("olivia", "delete from public.workspaces where id = $1 returning id", [workspace])).toBe("allowed");
    const left = await db.query("select (select count(*) from public.versions) + (select count(*) from public.reviews) + (select count(*) from public.comments) as n");
    expect(Number((left.rows[0] as { n: number }).n)).toBe(0);
  });
});
