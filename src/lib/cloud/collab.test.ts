import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { compareTables, mentionQuery, mentionsIn, snapshotToTables, splitMentions, threadsOf, type Comment, type Person } from "./collab";
import { toRow } from "./rows";
import { TABLE_NAMES, nodeKey, sameValue, toTables, type Tables } from "./tables";

const people: Person[] = [
  { userId: "u1", name: "Ana", email: "ana@example.com" },
  { userId: "u2", name: "Ana Maria Lopez", email: "anamaria@example.com" },
  { userId: "u3", name: "", email: "ben@example.com" },
];

describe("mentions", () => {
  it("finds the people named in a comment, longest name first", () => {
    expect(mentionsIn("@Ana Maria Lopez can you check? cc @ben@example.com", people)).toEqual(["u2", "u3"]);
    expect(mentionsIn("@Ana and @Ana Maria Lopez", people).sort()).toEqual(["u1", "u2"]);
    expect(mentionsIn("mail ana@example.com about it", people)).toEqual([]);
  });

  it("splits a comment into text and mentions for drawing", () => {
    expect(splitMentions("Ask @Ana Maria Lopez first, then @Ana.", people, ["u1", "u2"])).toEqual([
      { text: "Ask ", mention: false },
      { text: "@Ana Maria Lopez", mention: true },
      { text: " first, then ", mention: false },
      { text: "@Ana", mention: true },
      { text: ".", mention: false },
    ]);
    // A name that was typed but whose mention was not saved is plain text.
    expect(splitMentions("@Ana", people, [])).toEqual([{ text: "@Ana", mention: false }]);
  });

  it("knows when the person is in the middle of typing a mention", () => {
    expect(mentionQuery("Hello @An", 9)).toEqual({ start: 6, query: "An" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail me@example", 15)).toBeNull();
    expect(mentionQuery("no mention here", 15)).toBeNull();
    expect(mentionQuery("@Ana\nnext line", 14)).toBeNull();
  });
});

describe("threads", () => {
  it("groups replies under the comment they answer, in the order written", () => {
    const c = (id: string, parentId: string | null, createdAt: string): Comment => ({ id, parentId, createdAt, diagramId: "d", targetKind: "diagram", targetId: "d", body: id, mentions: [], resolved: false, authorId: "u1", editedAt: null });
    const threads = threadsOf([c("r2", "a", "2026-01-03"), c("b", null, "2026-01-02"), c("a", null, "2026-01-01"), c("r1", "a", "2026-01-02")]);
    expect(threads.map((t) => [t.root.id, ...t.replies.map((r) => r.id)])).toEqual([["a", "r1", "r2"], ["b"]]);
  });
});

describe("versions", () => {
  const tables = toTables(demoWorkspace("Tester"));

  it("reads a stored version back as the same model", () => {
    // What the database stores: the rows of each table, in database columns.
    const snapshot = Object.fromEntries((["objects", "relationships", "diagrams", "nodes"] as const).map((table) => [table, Object.entries(tables[table]).map(([key, value]) => toRow(table, "ws", key, value))]));
    const back = snapshotToTables(JSON.parse(JSON.stringify(snapshot)));
    for (const table of TABLE_NAMES) {
      // Drafts and decisions are not part of a version.
      if (table === "proposals" || table === "adrs") expect(back[table]).toEqual({});
      else expect(sameValue(back[table], tables[table])).toBe(true);
    }
    expect(snapshotToTables(null).objects).toEqual({});
  });

  it("finds no difference between a model and itself", () => {
    expect(compareTables(tables, tables).total).toBe(0);
  });

  it("lists what was added, removed and changed, with names instead of ids", () => {
    const [first, second, third] = Object.values(tables.objects);
    const relationship = Object.values(tables.relationships)[0];
    const diagram = Object.values(tables.diagrams)[0];
    const placed = Object.keys(tables.nodes).find((key) => key.startsWith(diagram.id))!;
    const after: Tables = {
      ...tables,
      objects: { ...tables.objects, [first.id]: { ...first, name: "Renamed", parentId: second.id, updatedAt: "2030-01-01T00:00:00.000Z" }, added: { ...third, id: "added", name: "Brand new" } },
      relationships: { ...tables.relationships, [relationship.id]: { ...relationship, label: "now labelled" } },
      diagrams: { ...tables.diagrams, [diagram.id]: { ...diagram, direction: diagram.direction === "TB" ? "LR" : "TB" } },
      nodes: { ...tables.nodes, [placed]: { ...tables.nodes[placed], x: tables.nodes[placed].x + 50 }, [nodeKey(diagram.id, "added")]: { x: 0, y: 0, pinned: false } },
    };
    delete after.objects[third.id];
    const c = compareTables(tables, after);
    expect(c.objects.added.map((o) => o.name)).toEqual(["Brand new"]);
    expect(c.objects.removed.map((o) => o.id)).toEqual([third.id]);
    expect(c.objects.changed).toHaveLength(1);
    // The timestamp alone would not count; the parent is shown by name.
    expect(c.objects.changed[0].fields.map((f) => f.field)).toEqual(["Name", "Inside"]);
    expect(c.objects.changed[0].fields[1].after).toBe(second.name);
    expect(c.relationships.changed[0].fields).toEqual([{ field: "Label", before: relationship.label || "nothing", after: "now labelled" }]);
    expect(c.diagrams.changed[0]).toMatchObject({ boxesAdded: 1, boxesMoved: 1, boxesRemoved: 0 });
    expect(c.diagrams.changed[0].fields.map((f) => f.field)).toEqual(["Direction"]);
    expect(c.total).toBe(5);
  });
});

import { auditAction, auditChanges, auditCsv, cleanSearch, dayBounds, matchesQuery, type AuditEntry } from "./audit";

describe("reading the audit log", () => {
  const entry = (over: Partial<AuditEntry>): AuditEntry => ({ id: 1, at: "2026-11-16T09:00:00.000Z", actorId: "u1", actorName: "Olivia", via: "app", entity: "object", entityId: "o1", entityName: "Ledger", action: "updated", changes: {}, ...over });

  it("shows each changed field with its value before and after, and object ids as names", () => {
    const changes = auditChanges(entry({ changes: { owner: ["Finance", ""], parent_id: [null, "o9"], tags: [["a"], ["a", "b"]], provenance: [{ origin: "manual" }, { origin: "import" }] } }), (id) => (id === "o9" ? "Core banking" : undefined));
    expect(changes).toEqual([
      { label: "Inside", before: "nothing", after: "Core banking" },
      { label: "Origin", before: "manual", after: "import" },
      { label: "Owner", before: "Finance", after: "nothing" },
      { label: "Tags", before: "a", after: "a, b" },
    ]);
  });
  it("shows a new row's fields without a before, and a note as it is", () => {
    expect(auditChanges(entry({ action: "created", changes: { name: [null, "Ledger"] } }))).toEqual([{ label: "Name", before: null, after: "Ledger" }]);
    expect(auditChanges(entry({ entity: "diagram", action: "object added", changes: { object: "Ledger DB" } }))).toEqual([{ label: "Object", before: null, after: "Ledger DB" }]);
  });
  it("words the action plainly", () => {
    expect(auditAction(entry({}))).toBe("updated object");
    expect(auditAction(entry({ entity: "diagram", action: "object removed" }))).toBe("removed an object from diagram");
    expect(auditAction(entry({ entity: "diagram", action: "object added", changes: { object: "Ledger DB" } }))).toBe('added "Ledger DB" to diagram');
    expect(auditAction(entry({ entity: "member", action: "role changed" }))).toBe("changed the role of member");
    expect(auditAction(entry({ entity: "review", action: "stage approved" }))).toBe("approved a stage of review");
  });
  it("writes a CSV with one line per entry and the changes spelled out", () => {
    const csv = auditCsv([entry({ changes: { owner: ["Finance", "Treasury"] } }), entry({ id: 2, actorName: 'API key "CI"', via: "api", action: "created", changes: { name: [null, "Risk, engine"] } })]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Owner: Finance -> Treasury");
    expect(lines[2]).toContain('"API key ""CI"""');
    expect(lines[2]).toContain('"Name: Risk, engine"');
  });
  it("filters by kind, words and whole local days, and cleans what goes into a search", () => {
    const e = entry({ at: new Date(2026, 10, 16, 23, 30).toISOString() });
    expect(matchesQuery(e, { from: "2026-11-16", to: "2026-11-16" })).toBe(true);
    expect(matchesQuery(e, { to: "2026-11-15" })).toBe(false);
    expect(matchesQuery(e, { from: "2026-11-17" })).toBe(false);
    expect(matchesQuery(e, { entity: "diagram" })).toBe(false);
    expect(matchesQuery(e, { search: "LEDG" })).toBe(true);
    expect(matchesQuery(e, { search: "edgar" })).toBe(false);
    expect(matchesQuery(e, { before: 1 })).toBe(false);
    expect(cleanSearch('a,b)"%(or x.eq.1')).toBe("a b or x.eq.1");
    expect(dayBounds("not-a-date").since).toBeUndefined();
  });
});

import { diagramSvg, evidenceHtml } from "./evidence";

describe("the evidence pack", () => {
  const ws = demoWorkspace();
  const base = toTables(ws);
  const changedWs = { ...ws, objects: { ...ws.objects } };
  const cache = Object.values(ws.objects).find((o) => o.name === "Session cache")!;
  changedWs.objects[cache.id] = { ...cache, lifecycle: "retired", owner: "<script>alert(1)</script>" };
  const people = [
    { userId: "u1", name: "Olivia Owner", email: "olivia@example.com" },
    { userId: "u2", name: "", email: "edgar@example.com" },
  ];
  const review = {
    id: "r1", versionId: "v2", baseVersionId: "v1", title: "Retire the session cache", note: "As agreed in the board", status: "approved" as const,
    stages: [
      { id: "s1", name: "Architecture", reviewerId: "u1", checklist: ["Owners named", "Diagrams updated"] },
      { id: "s2", name: "Security", reviewerId: "u1", checklist: [] },
    ],
    stageIndex: 1,
    decisions: [
      { stageId: "s1", stageName: "Architecture", by: "u1", decision: "approved" as const, reason: "", checklist: [true, false], at: "2026-11-16T09:30:00.000Z" },
      { stageId: "s2", stageName: "Security", by: "u1", decision: "delegated" as const, reason: "", checklist: [], to: "u2", at: "2026-11-16T09:40:00.000Z" },
      { stageId: "s2", stageName: "Security", by: "u2", decision: "approved" as const, reason: "Fine & <checked>", checklist: [], at: "2026-11-16T10:05:00.000Z" },
    ],
    submittedBy: "u2", submittedAt: "2026-11-16T09:00:00.000Z", closedAt: "2026-11-16T10:05:00.000Z",
  };
  const version = { id: "v2", name: "Submitted: Retire the session cache", note: "", kind: "review" as const, objects: 22, relationships: 25, diagrams: 3, createdBy: "u2", createdAt: "2026-11-16T09:00:00.000Z" };
  const html = evidenceHtml({ workspaceName: "Payments", review, version, tables: toTables(changedWs), base, people, generatedBy: "Olivia Owner", generatedAt: "2026-11-16T11:00:00.000Z" });

  it("names the outcome, who submitted and each decision with its time", () => {
    expect(html).toContain('data-outcome="approved">Approved');
    expect(html).toContain("edgar@example.com, 2026-11-16 09:00 UTC");
    expect(html).toContain("<strong>Approved</strong> by Olivia Owner, 2026-11-16 09:30 UTC");
    expect(html).toContain("<strong>Handed to edgar@example.com</strong> by Olivia Owner");
    expect(html).toContain("22 objects, 25 relationships, 3 diagrams");
  });
  it("shows each checklist as it was ticked", () => {
    expect(html).toContain("<li>☑ Owners named</li><li>☐ Diagrams updated</li>");
  });
  it("lists what changed and the findings of the checks on the reviewed version", () => {
    expect(html).toContain("<strong>Objects changed (1):</strong> Session cache (");
    expect(html).toContain("which is retired.");
    expect(html).toMatch(/27 rules from the packs .* were run against the reviewed version: \d+ high, \d+ medium, \d+ low\./);
    expect(html).toContain("not a certificate of compliance");
  });
  it("draws every diagram and stands alone: no scripts, no outside files", () => {
    expect((html.match(/<figure>/g) ?? []).length).toBe(3);
    expect((html.match(/<svg /g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/<script|<link |src="http|href="http/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;".slice(0, 0) + "Fine &amp; &lt;checked&gt;");
  });
  it("draws boxes where they were placed, with arrows that stop at the box edge", () => {
    const diagram = Object.values(ws.diagrams)[0];
    const svg = diagramSvg(ws, diagram);
    expect((svg.match(/<rect /g) ?? []).length).toBe(Object.keys(diagram.nodes).length);
    expect(svg).toContain('marker-end="url(#arrow)"');
    expect(diagramSvg(ws, { ...diagram, nodes: {} })).toBe("");
  });
  it("says so when nothing was published before, or the review was rejected", () => {
    const first = evidenceHtml({ workspaceName: "Payments", review: { ...review, status: "rejected", baseVersionId: null }, version: undefined, tables: base, base: null, people, generatedBy: "x", generatedAt: "2026-11-16T11:00:00.000Z" });
    expect(first).toContain('data-outcome="rejected">Rejected');
    expect(first).toContain("Nothing had been published before this review");
    expect(first).toContain("A version that has since been deleted");
  });
});
