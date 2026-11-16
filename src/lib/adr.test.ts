import { describe, expect, it } from "vitest";
import { adrLabel, adrLocked, adrLogMarkdown, adrMarkdown, adrsAbout, createAdr, decideAdr, deleteAdr, reviewAdr, setAdrObjects, sortedAdrs, supersedeAdr, updateAdr } from "./adr";
import type { Review } from "./cloud/collab";
import { toTables } from "./cloud/tables";
import { createObject, createRelationship, emptyWorkspace, updateObject } from "./model";
import { workspaceSchema } from "./types";

function seeded() {
  let ws = emptyWorkspace("Test");
  const a = createObject(ws, { name: "Ledger", typeId: "service" });
  const b = createObject(a.ws, { name: "Ledger DB", typeId: "database" });
  ws = b.ws;
  return { ws, ledger: a.object, db: b.object };
}

describe("decision records", () => {
  it("numbers records in order and keeps them proposed until someone decides", () => {
    const { ws, ledger } = seeded();
    const first = createAdr(ws, { title: " One queue ", author: "Olivia", objectIds: [ledger.id, ledger.id, "missing"] });
    const second = createAdr(first.ws, { title: "", author: "Olivia" });
    expect([first.adr.number, second.adr.number]).toEqual([1, 2]);
    expect(first.adr).toMatchObject({ title: "One queue", status: "proposed", objectIds: [ledger.id], origin: "manual", decidedAt: null });
    expect(second.adr.title).toBe("Untitled decision");
    expect(sortedAdrs(second.ws).map(adrLabel)).toEqual(["ADR-2", "ADR-1"]);
    expect(adrsAbout(second.ws, ledger.id).map((a) => a.id)).toEqual([first.adr.id]);
  });

  it("fixes the text once a record is decided, but lets its links be corrected", () => {
    const { ws, ledger, db } = seeded();
    const made = createAdr(ws, { title: "One queue", author: "Olivia" });
    let next = updateAdr(made.ws, made.adr.id, { decision: "We will use Kafka." });
    expect(updateAdr(next, made.adr.id, { decision: "We will use Kafka." })).toBe(next);
    next = decideAdr(next, made.adr.id, "accepted");
    const accepted = next.adrs[made.adr.id];
    expect(accepted.status).toBe("accepted");
    expect(accepted.decidedAt).not.toBeNull();
    expect(adrLocked(accepted)).toBe(true);
    expect(updateAdr(next, made.adr.id, { decision: "RabbitMQ" })).toBe(next);
    expect(decideAdr(next, made.adr.id, "rejected")).toBe(next);
    expect(deleteAdr(next, made.adr.id)).toBe(next);
    next = setAdrObjects(next, made.adr.id, [ledger.id, db.id]);
    expect(next.adrs[made.adr.id].objectIds).toEqual([ledger.id, db.id]);
    expect(next.adrs[made.adr.id].decision).toBe("We will use Kafka.");
  });

  it("supersedes an accepted record with a new one, and undoes that when the new one is discarded", () => {
    const { ws, ledger } = seeded();
    const made = createAdr(ws, { title: "One queue", decision: "Kafka", author: "Olivia", objectIds: [ledger.id] });
    expect(supersedeAdr(made.ws, made.adr.id, "Edgar").adr).toBeNull();
    const accepted = decideAdr(made.ws, made.adr.id, "accepted");
    const replaced = supersedeAdr(accepted, made.adr.id, "Edgar");
    expect(replaced.adr).toMatchObject({ number: 2, status: "proposed", author: "Edgar", objectIds: [ledger.id], context: "Replaces ADR-1: One queue." });
    expect(replaced.ws.adrs[made.adr.id]).toMatchObject({ status: "superseded", supersededBy: replaced.adr!.id, decision: "Kafka" });
    const undone = deleteAdr(replaced.ws, replaced.adr!.id);
    expect(undone.adrs[made.adr.id]).toMatchObject({ status: "accepted", supersededBy: null });
    expect(Object.keys(undone.adrs)).toEqual([made.adr.id]);
  });

  it("writes a record as Markdown in the usual layout", () => {
    const { ws, ledger } = seeded();
    const made = createAdr(ws, { title: "One queue", context: "Three brokers.", decision: "We will use Kafka.", author: "Olivia", objectIds: [ledger.id] });
    const text = adrMarkdown(made.ws, made.adr);
    expect(text).toContain("# ADR-1: One queue");
    expect(text).toContain("- Status: Proposed");
    expect(text).toContain("- About: Ledger");
    expect(text).toMatch(/## Context\n\nThree brokers\.\n\n## Decision\n\nWe will use Kafka\.\n\n## Consequences\n\nNot written\./);
    const two = createAdr(made.ws, { title: "Second", author: "Olivia" });
    expect(adrLogMarkdown(two.ws).indexOf("ADR-1")).toBeLessThan(adrLogMarkdown(two.ws).indexOf("ADR-2"));
  });

  it("opens a workspace saved before decisions existed", () => {
    const { adrs: _none, ...old } = emptyWorkspace("Old");
    expect(workspaceSchema.parse(old).adrs).toEqual({});
  });
});

describe("the record a closed review leaves", () => {
  const { ws, ledger, db } = seeded();
  const before = toTables(ws);
  let changed = updateObject(ws, ledger.id, { owner: "Payments" });
  const queue = createObject(changed, { name: "Events", typeId: "queue" });
  changed = createRelationship(queue.ws, { sourceId: ledger.id, targetId: queue.object.id, kind: "calls" }).ws;
  const after = toTables(changed);
  const names: Record<string, string> = { u1: "Olivia", u2: "Vera", u3: "Edgar" };
  const nameOf = (id: string | null) => names[id ?? ""] ?? "Former member";
  const review = (status: Review["status"], decisions: Review["decisions"]): Review => ({
    id: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    versionId: "v2",
    baseVersionId: "v1",
    title: "Add the events queue",
    note: "For the Q3 release",
    status,
    stages: [],
    stageIndex: 0,
    decisions,
    submittedBy: "u3",
    submittedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-02T00:00:00.000Z",
  });
  const decision = (stageName: string, by: string, what: "approved" | "rejected", reason = "") => ({ stageId: stageName, stageName, by, decision: what, reason, checklist: [], at: "2026-01-02T00:00:00.000Z" });

  it("says who approved and what the change did", () => {
    const adr = reviewAdr(review("approved", [decision("Architecture", "u1", "approved"), decision("Security", "u2", "approved")]), before, after, nameOf, 4)!;
    expect(adr).toMatchObject({
      id: "adr_0a1b2c3d4e5f",
      number: 4,
      status: "accepted",
      title: "Add the events queue",
      context: "For the Q3 release",
      decision: "Approved in review. Architecture: Olivia; Security: Vera.",
      consequences: "Objects: 1 added, 1 changed, 0 removed. Relationships: 1 added, 0 changed, 0 removed. The reviewed model became the published version.",
      origin: "review",
      author: "Edgar",
      decidedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(adr.objectIds).toEqual([ledger.id, queue.object.id].sort());
    expect(adr.objectIds).not.toContain(db.id);
  });

  it("keeps the reason of a rejection, and writes nothing for an open or withdrawn review", () => {
    const adr = reviewAdr(review("rejected", [decision("Security", "u2", "rejected", "Reachable from the internet")]), null, after, nameOf, 1)!;
    expect(adr.status).toBe("rejected");
    expect(adr.decision).toBe('Rejected in review at the stage "Security" by Vera. Reason: Reachable from the internet');
    expect(adr.consequences).toMatch(/^Objects: 3 added, 0 changed, 0 removed\..* The published version stays as it was\.$/);
    expect(reviewAdr(review("withdrawn", []), before, after, nameOf, 1)).toBeNull();
    expect(reviewAdr(review("open", []), before, after, nameOf, 1)).toBeNull();
  });
});
