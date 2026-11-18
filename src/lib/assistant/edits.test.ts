import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { findByName } from "../model";
import type { Workspace } from "../types";
import { applyOps, clearedFindings, describeOp, diagramFindings, newFindings, readPlan, type EditOp } from "./edits";

const who = { by: "Khaled", source: "Add a web server and connect it", engine: "Test model (assistant)" };
const diagramNamed = (ws: Workspace, name: string) => Object.values(ws.diagrams).find((d) => d.name === name)!;
const block = (plan: unknown) => `Here is the change.\n\n\`\`\`archone-changes\n${JSON.stringify(plan)}\n\`\`\`\n`;

describe("reading the assistant's changes", () => {
  it("takes the block out of the answer and reads its three lists", () => {
    const { text, plan, dropped } = readPlan(
      block({
        apply: [{ op: "add_object", ref: "n1", name: "Web server 1", type: "server" }],
        confirm: [{ op: "delete_connection", from: "A", to: "B" }],
        suggest: [{ op: "update_object", id: "n1", owner: "Infrastructure" }],
      }),
    );
    expect(text).toBe("Here is the change.");
    expect(dropped).toBe(0);
    expect(plan?.apply.map((op) => op.op)).toEqual(["add_object"]);
    expect(plan?.confirm.map((op) => op.op)).toEqual(["delete_connection"]);
    expect(plan?.suggest.map((s) => s.ops.map((op) => op.op))).toEqual([["update_object"]]);
  });

  it("reads a suggestion that takes several changes, with its words", () => {
    const { plan } = readPlan(
      block({
        suggest: [
          { say: "Put a firewall in front of Orders database", ops: [{ op: "add_object", ref: "fw", name: "Edge firewall", type: "network" }, { op: "connect", from: "fw", to: "Orders database" }, { op: "bogus" }] },
          { say: "Nothing readable", ops: [{ op: "bogus" }] },
        ],
      }),
    );
    expect(plan?.suggest).toHaveLength(1);
    expect(plan?.suggest[0].say).toBe("Put a firewall in front of Orders database");
    expect(plan?.suggest[0].ops.map((op) => op.op)).toEqual(["add_object", "connect"]);
  });

  it("never makes a removal without a yes, whichever list it came in", () => {
    const { plan } = readPlan(block({ apply: [{ op: "hide_object", id: "x" }, { op: "delete_object", id: "y" }, { op: "tidy" }] }));
    expect(plan?.apply.map((op) => op.op)).toEqual(["tidy"]);
    expect(plan?.confirm.map((op) => op.op)).toEqual(["hide_object", "delete_object"]);
  });

  it("leaves out what it cannot read, and an answer without a block is only text", () => {
    const { plan, dropped } = readPlan(block({ apply: [{ op: "explode" }, { op: "connect", from: "a" }, { op: "rename_diagram", name: "New name" }] }));
    expect(plan?.apply).toEqual([{ op: "rename_diagram", name: "New name" }]);
    expect(dropped).toBe(2);
    expect(readPlan("Which server do you mean?")).toEqual({ text: "Which server do you mean?", plan: null, dropped: 0 });
    expect(readPlan("Oops\n```archone-changes\n{not json\n```").plan).toBeNull();
  });

  it("reads ports given as numbers, and leaves out values it does not know rather than the change", () => {
    const { plan } = readPlan(block({ apply: [{ op: "connect", from: "a", to: "b", kind: "reads-writes", encrypted: true, protocols: [{ name: "HTTPS", port: 443, transport: "QUIC" }] }, { op: "add_object", name: "Box", lifecycle: "someday" }] }));
    const [op, add] = plan!.apply;
    expect(op).toMatchObject({ op: "connect", kind: "reads_writes", encrypted: "yes", protocols: [{ name: "HTTPS", port: "443" }] });
    expect(op.op === "connect" && op.protocols?.[0].transport).toBeUndefined();
    expect(add.op === "add_object" && add.lifecycle).toBeUndefined();
  });
});

describe("making the assistant's changes", () => {
  it("adds objects, connects them with protocols and places them on the diagram", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const db = findByName(ws, "Orders database")!;
    const ops: EditOp[] = [
      { op: "add_object", ref: "n1", name: "Web server 1", type: "server", technology: "IIS 10", fields: { "IP address": "10.0.1.5", "Operating system": "Windows Server 2022" } },
      { op: "connect", from: "n1", to: db.id, kind: "reads_writes", protocols: [{ name: "PostgreSQL", port: "5432", transport: "TCP" }], encrypted: "yes", network: "Data VLAN" },
    ];
    const done = applyOps(ws, diagram.id, ops, who);
    const server = findByName(done.ws, "Web server 1")!;
    expect(server.typeId).toBe("server");
    expect(server.fields["IP address"]).toBe("10.0.1.5");
    expect(server.provenance?.origin).toBe("ai-prompt");
    expect(done.ws.diagrams[diagram.id].nodes[server.id]).toBeTruthy();
    const link = Object.values(done.ws.relationships).find((r) => r.sourceId === server.id && r.targetId === db.id)!;
    expect(link.protocols).toEqual([{ name: "PostgreSQL", port: "5432", transport: "TCP" }]);
    expect(link.encrypted).toBe("yes");
    expect(link.network).toBe("Data VLAN");
    expect(done.lines).toEqual(["Added Web server 1 (Server or VM)", "Connected Web server 1 → Orders database over PostgreSQL 5432/TCP, encrypted"]);
    expect(done.problems).toEqual([]);
  });

  it("shows an object that already exists instead of making a copy", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "System landscape");
    const before = Object.keys(ws.objects).length;
    const done = applyOps(ws, diagram.id, [{ op: "add_object", name: "orders database", type: "database" }], who);
    expect(Object.keys(done.ws.objects)).toHaveLength(before);
    expect(done.ws.diagrams[diagram.id].nodes[findByName(ws, "Orders database")!.id]).toBeTruthy();
    expect(done.lines[0]).toMatch(/already in the model/);
  });

  it("changes details by name, removes an empty field and says what it could not do", () => {
    let ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const db = findByName(ws, "Orders database")!;
    ws = { ...ws, objects: { ...ws.objects, [db.id]: { ...db, fields: { "Old field": "x" } } } };
    const done = applyOps(
      ws,
      diagram.id,
      [
        { op: "update_object", id: "Orders database", owner: "Data team", fields: { "Data classification": "Confidential", "Old field": "" } },
        { op: "update_object", id: "No such thing", owner: "Someone" },
      ],
      who,
    );
    expect(done.ws.objects[db.id].owner).toBe("Data team");
    expect(done.ws.objects[db.id].fields).toEqual({ "Data classification": "Confidential" });
    expect(done.problems).toEqual(['No object "No such thing" to change']);
  });

  it("takes an object off the diagram and keeps it in the model", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const cache = findByName(ws, "Session cache")!;
    expect(diagram.nodes[cache.id]).toBeTruthy();
    const done = applyOps(ws, diagram.id, [{ op: "hide_object", id: cache.id }], who);
    expect(done.ws.diagrams[diagram.id].nodes[cache.id]).toBeUndefined();
    expect(done.ws.objects[cache.id]).toBeTruthy();
  });

  it("sets parents whatever order the plan names them in", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Deployment");
    const done = applyOps(
      ws,
      diagram.id,
      [
        { op: "add_object", ref: "vm", name: "App VM", type: "server", parent: "zone" },
        { op: "add_object", ref: "zone", name: "DMZ", type: "zone" },
      ],
      who,
    );
    expect(findByName(done.ws, "App VM")!.parentId).toBe(findByName(done.ws, "DMZ")!.id);
  });

  it("finds an object an earlier step added by the ref the plan gave it", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const plan: EditOp[] = [
      { op: "add_object", ref: "n1", name: "Web server 1", type: "server" },
      { op: "update_object", id: "n1", owner: "Infrastructure" },
    ];
    const first = applyOps(ws, diagram.id, [plan[0]], who, plan);
    const later = applyOps(first.ws, diagram.id, [plan[1]], who, plan);
    expect(findByName(later.ws, "Web server 1")!.owner).toBe("Infrastructure");
    expect(later.problems).toEqual([]);
  });

  it("describes waiting changes in words, with the names of objects the plan adds", () => {
    const ws = demoWorkspace("Khaled");
    const plan: EditOp[] = [
      { op: "add_object", ref: "fw", name: "Edge firewall", type: "network" },
      { op: "connect", from: "fw", to: "API gateway", protocols: [{ name: "HTTPS", port: "443" }] },
    ];
    expect(describeOp(ws, plan[1], plan)).toBe("Connect Edge firewall → API gateway over HTTPS 443");
    expect(describeOp(ws, { op: "delete_object", id: findByName(ws, "Session cache")!.id })).toBe("Delete Session cache from the whole model");
  });
});

describe("what the checks say about a change", () => {
  it("warns about what a change breaks and counts what it clears", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const before = diagramFindings(ws, diagram.id);
    const done = applyOps(ws, diagram.id, [{ op: "add_object", ref: "s", name: "Legacy box", type: "server", lifecycle: "deprecated" }], who);
    const after = diagramFindings(done.ws, diagram.id);
    const added = newFindings(done.ws, before, after);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((line) => /^\[(high|medium)\] /.test(line))).toBe(true);
    expect(added.some((line) => line.includes("Legacy box"))).toBe(true);
    expect(clearedFindings(after, before)).toBe(added.length);
  });
});
