import { describe, expect, it } from "vitest";
import type { DiagramRecord } from "../approvals";
import type { Comment } from "../cloud/collab";
import { demoWorkspace } from "../demo";
import { findByName } from "../model";
import type { Workspace } from "../types";
import { parseAnswer, parseInline, tagsIn } from "./answer";
import { assistantContext, focusOf } from "./context";

function sample(): Workspace {
  const ws = demoWorkspace("Khaled");
  const db = findByName(ws, "Orders database")!;
  ws.objects[db.id] = { ...db, owner: "Data team", fields: { "IP address": "10.20.0.15", "Operating system": "Ubuntu 24.04", "Data classification": "Confidential", "Personal data": "Yes" } };
  const service = findByName(ws, "Order service")!;
  const store = Object.values(ws.relationships).find((r) => r.sourceId === service.id && r.targetId === db.id)!;
  ws.relationships[store.id] = { ...store, protocols: [{ name: "PostgreSQL", port: "5432", transport: "TCP" }], network: "Data VLAN", encrypted: "no" };
  return ws;
}
const diagramNamed = (ws: Workspace, name: string) => Object.values(ws.diagrams).find((d) => d.name === name)!;

function recordFor(diagramId: string): DiagramRecord {
  return {
    diagramId,
    fingerprint: "f1",
    status: "returned",
    version: 2,
    approvedVersion: 1,
    approvedAt: "2026-11-10T08:00:00.000Z",
    approvedFingerprint: "f0",
    request: { id: "req1", version: 2, status: "returned", round: 1, note: "New payment flow", requestedById: "u1", requestedBy: "Sara", requestedAt: "2026-11-17T09:30:00.000Z", sentFingerprint: "f1" },
    roles: {
      ea: { state: "approved", by: "Omar", at: "2026-11-17T10:00:00.000Z", note: "", withChanges: true },
      security: { state: "returned", by: "Huda", at: "2026-11-17T11:15:00.000Z", note: "Encrypt the link to the orders database", withChanges: false },
    },
    required: true,
    created: { at: "2026-10-01T07:00:00.000Z", by: "Sara" },
    changed: { at: "2026-11-17T09:00:00.000Z", by: "Ali" },
    approvers: { ea: [{ id: "u2", name: "Omar" }], security: [{ id: "u3", name: "Huda" }] },
    mine: { ea: false, security: false },
    history: [
      { kind: "returned", role: "security", by: "Huda", at: "2026-11-17T11:15:00.000Z", note: "Encrypt the link to the orders database", version: 2, round: 1 },
      { kind: "submitted", role: null, by: "Sara", at: "2026-11-17T09:30:00.000Z", note: "New payment flow", version: 2, round: 1 },
    ],
  };
}

describe("what the assistant knows", () => {
  it("gives the diagram on screen in full: maker, approval and notes, objects with their details, connections with protocols, findings and comments", () => {
    const ws = sample();
    const inside = diagramNamed(ws, "Inside Online store");
    const db = findByName(ws, "Orders database")!;
    const comment: Comment = { id: "c1", diagramId: inside.id, targetKind: "object", targetId: db.id, parentId: null, body: "Is the backup tested?", mentions: [], resolved: false, authorId: "u1", createdAt: "2026-11-16T12:00:00.000Z", editedAt: null };
    const { text, complete, focus } = assistantContext(
      { ws, page: { diagramId: inside.id }, records: { [inside.id]: recordFor(inside.id) }, comments: [comment], people: [{ userId: "u1", name: "Sara", email: "sara@example.com" }], me: { name: "Khaled", role: "owner" }, today: "2026-11-18" },
      ["What did Cybersecurity say?"],
    );
    expect(complete).toBe(true);
    expect(focus.diagramIds).toEqual([inside.id]);
    expect(text).toContain(`DIAGRAM [[d:${inside.id}]] Inside Online store`);
    expect(text).toContain("Made by Sara on 2026-10-01 07:00; last changed by Ali on 2026-11-17 09:00");
    expect(text).toContain("Approval: Returned for changes; version 2 (last approved version 1, 2026-11-10 08:00). Approval by Enterprise Architecture and Cybersecurity is compulsory");
    expect(text).toContain("Enterprise Architecture: changed and approved by Omar on 2026-11-17 10:00");
    expect(text).toContain('Cybersecurity: returned it for changes (Huda, 2026-11-17 11:15); note: "Encrypt the link to the orders database"');
    expect(text).toContain(`[[${db.id}]] Orders database | type: Database | owner: Data team`);
    expect(text).toContain("details: IP address=10.20.0.15; Operating system=Ubuntu 24.04; Data classification=Confidential; Personal data=Yes");
    expect(text).toMatch(/-> \[\[[^\]]+\]\] \| reads \/ writes \| connection id rel_\w+ \| protocols: PostgreSQL 5432\/TCP \| network: Data VLAN \| encrypted: no/);
    expect(text).toContain("What the checks find on this diagram");
    expect(text).toMatch(/\[medium\] NCA ECC \(Saudi Arabia\) · Where classified data is hosted is written down \| Orders database holds confidential data/);
    expect(text).toContain(`Sara, 2026-11-16 12:00, on [[${db.id}]] in [[d:${inside.id}]] (open): "Is the backup tested?"`);
    expect(text).toContain("Asked by: Khaled, owner of this workspace.");
    // Emails of people are not written out when they have a name.
    expect(text).not.toContain("sara@example.com");
    // The index of every diagram follows.
    expect(text).toContain(`[[d:${diagramNamed(ws, "Deployment").id}]] Deployment`);
  });

  it("finds the diagrams and objects a message names, in Arabic or English, latest message first", () => {
    const ws = sample();
    const deployment = diagramNamed(ws, "Deployment");
    const focus = focusOf(ws, ["Tell me about the System landscape", "ما هي السيرفرات في مخطط Deployment وما علاقتها بـ Orders database؟"]);
    expect(focus.diagramIds[0]).toBe(deployment.id);
    expect(focus.diagramIds).toContain(diagramNamed(ws, "System landscape").id);
    expect(focus.objectIds).toContain(findByName(ws, "Orders database")!.id);
  });

  it("cuts a workspace that does not fit, keeps the focus whole, and says what was left out", () => {
    const ws = sample();
    for (let i = 0; i < 600; i++) {
      const id = `obj_extra${i}`;
      ws.objects[id] = { ...findByName(ws, "Order service")!, id, name: `Extra service ${i}`, description: "x".repeat(200) };
    }
    const inside = diagramNamed(ws, "Inside Online store");
    const { text, complete } = assistantContext({ ws, page: { diagramId: inside.id }, records: { [inside.id]: recordFor(inside.id) } }, ["hi"], 40_000);
    expect(complete).toBe(false);
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(text).toContain("Encrypt the link to the orders database");
    expect(text).toMatch(/more lines of this section not listed, to fit/);
  });
});

describe("reading an answer", () => {
  it("turns tags into links, keeps bold, lists, tables and code, and leaves everything else as text", () => {
    const blocks = parseAnswer(
      "### Summary\n**[[d:dia_1]]** has 2 servers:\n- [[obj_a]] runs `Ubuntu`\n  - on 10.0.0.1\n1. Fix the link\n2. Ask again\n\n| Server | IP |\n|---|---|\n| [[obj_a]] | 10.0.0.1 |\n\n<script>alert(1)</script>",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "table", "paragraph"]);
    expect(blocks[1]).toMatchObject({ inline: [{ kind: "bold", children: [{ kind: "diagram", id: "dia_1" }] }, { kind: "text", text: " has 2 servers:" }] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [{ level: 0, inline: [{ kind: "object", id: "obj_a" }, { kind: "text", text: " runs " }, { kind: "code", text: "Ubuntu" }] }, { level: 1 }] });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 1 });
    expect(blocks[4]).toMatchObject({ kind: "table", rows: [[[{ kind: "object", id: "obj_a" }], [{ kind: "text", text: "10.0.0.1" }]]] });
    expect(blocks[5]).toEqual({ kind: "paragraph", inline: [{ kind: "text", text: "<script>alert(1)</script>" }] });
    expect(parseInline("a [[bad tag]] b")).toEqual([{ kind: "text", text: "a [[bad tag]] b" }]);
    expect(tagsIn("[[obj_a]] and [[d:dia_1]] and [[obj_a]]")).toEqual({ objectIds: ["obj_a"], diagramIds: ["dia_1"] });
  });
});
