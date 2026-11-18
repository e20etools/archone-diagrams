import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { findByName, removeNodes, setRelationshipHidden, updateDiagram } from "../model";
import { visibleEdges } from "../views";
import type { Workspace } from "../types";
import { applyOps, clearedFindings, describeOp, diagramFindings, holdWipes, newFindings, readPlan, type EditOp } from "./edits";

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

  it("makes removals as asked, like a person would, but never deletes the diagram without a yes", () => {
    const { plan } = readPlan(block({ apply: [{ op: "hide_object", id: "x" }, { op: "delete_object", id: "y" }, { op: "delete_diagram" }, { op: "tidy" }], suggest: [{ op: "delete_diagram" }] }));
    expect(plan?.apply.map((op) => op.op)).toEqual(["hide_object", "delete_object", "tidy"]);
    expect(plan?.confirm.map((op) => op.op)).toEqual(["delete_diagram"]);
    expect(plan?.suggest).toEqual([]);
  });

  it("holds back taking everything off the diagram for a yes, as it would deleting it", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const ids = Object.keys(diagram.nodes);
    const all = { apply: ids.map((id): EditOp => ({ op: "hide_object", id })), confirm: [], suggest: [] };
    const held = holdWipes(ws, diagram.id, { ...all, apply: [...all.apply, { op: "tidy" }] }, who);
    expect(held.apply.map((op) => op.op)).toEqual(["tidy"]);
    expect(held.confirm).toHaveLength(ids.length);
    // Taking a few off is an ordinary change.
    const few = { apply: ids.slice(0, 2).map((id): EditOp => ({ op: "hide_object", id })), confirm: [], suggest: [] };
    expect(holdWipes(ws, diagram.id, few, who)).toBe(few);
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

  it("shows a connection that is in the model but not drawn, whatever kept it off the diagram", () => {
    let ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const db = findByName(ws, "Orders database")!;
    const link = Object.values(ws.relationships).find((r) => r.targetId === db.id && r.sourceId in diagram.nodes)!;
    ws = setRelationshipHidden(ws, diagram.id, link.id, true);
    ws = updateDiagram(ws, diagram.id, { edgeKinds: ["calls"] });
    ws = removeNodes(ws, diagram.id, [db.id]);
    const done = applyOps(ws, diagram.id, [{ op: "show_connection", id: link.id }], who);
    const after = done.ws.diagrams[diagram.id];
    expect(after.hiddenRelationshipIds).not.toContain(link.id);
    expect(after.edgeKinds === null || after.edgeKinds.includes(link.kind)).toBe(true);
    expect(after.nodes[db.id]).toBeTruthy();
    expect(visibleEdges(done.ws, after).some((e) => e.relationshipIds.includes(link.id))).toBe(true);
    expect(done.lines[0]).toMatch(/^Showed the connection .* → Orders database$/);
    // Asked to connect the same two again, it shows and changes that connection rather than copying it.
    const hidden = setRelationshipHidden(ws, diagram.id, link.id, true);
    const again = applyOps(hidden, diagram.id, [{ op: "connect", from: link.sourceId, to: db.id, encrypted: "yes" }], who);
    expect(Object.keys(again.ws.relationships)).toHaveLength(Object.keys(ws.relationships).length);
    expect(again.ws.relationships[link.id].encrypted).toBe("yes");
    expect(again.ws.diagrams[diagram.id].hiddenRelationshipIds).not.toContain(link.id);
    expect(again.lines[0]).toMatch(/was already connected: shown here and changed, encrypted$/);
  });

  it("draws a connection asked to be shown that is not in the model yet, and hides one on this diagram only", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const cache = findByName(ws, "Session cache")!;
    const db = findByName(ws, "Orders database")!;
    const shown = applyOps(ws, diagram.id, [{ op: "show_connection", from: cache.id, to: db.id }], who);
    const made = Object.values(shown.ws.relationships).find((r) => r.sourceId === cache.id && r.targetId === db.id)!;
    expect(made.provenance?.origin).toBe("ai-prompt");
    expect(shown.lines[0]).toMatch(/it was not in the model/);
    const hidden = applyOps(shown.ws, diagram.id, [{ op: "hide_connection", from: cache.id, to: db.id }], who);
    expect(hidden.ws.diagrams[diagram.id].hiddenRelationshipIds).toContain(made.id);
    expect(hidden.ws.relationships[made.id]).toBeTruthy();
  });

  it("adds a component or a protocol the library does not have, and uses it", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const done = applyOps(
      ws,
      diagram.id,
      [
        { op: "add_object", ref: "q", name: "Quantum vault 1", type: "database", component: "Zyxwv QuantumVault" },
        { op: "connect", from: "q", to: "Orders database", protocols: [{ name: "QVP", port: "7777", transport: "TCP" }] },
        { op: "add_object", name: "Pg box", component: "PostgreSQL" },
      ],
      who,
    );
    const own = Object.values(done.ws.library ?? {}).find((i) => i.type === "component" && i.component?.name === "Zyxwv QuantumVault")!;
    expect(own.component?.kind).toBe("database");
    expect(findByName(done.ws, "Quantum vault 1")!.componentId).toBe(own.id);
    expect(Object.values(done.ws.library ?? {}).some((i) => i.type === "protocol" && i.protocol?.name === "QVP" && i.protocol.port === "7777")).toBe(true);
    // One the library has is used, not added again.
    expect(Object.values(done.ws.library ?? {}).filter((i) => i.type === "component")).toHaveLength(1);
    expect(done.lines).toContain("Added Zyxwv QuantumVault to the component library");
    expect(done.lines).toContain("Added the protocol QVP to the library");
  });

  it("does on the diagram what a person does: moves and lines up boxes, settings, flows, a diagram as a box", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const other = diagramNamed(ws, "System landscape");
    const [a, b, c2] = Object.keys(diagram.nodes);
    const done = applyOps(
      ws,
      diagram.id,
      [
        { op: "move_object", id: a, near: b, side: "below" },
        { op: "arrange", ids: [a, b, c2], align: "left" },
        { op: "set_diagram", direction: "LR", colorBy: "owner", arrows: ["calls", "reads_writes"] },
        { op: "info_box", show: true, corner: "top-left" },
        { op: "add_diagram_box", ref: "box", diagram: "System landscape" },
        { op: "add_flow", name: "Checkout", steps: [{ from: a, to: b, text: "Sends the order" }] },
      ],
      who,
    );
    const d = done.ws.diagrams[diagram.id];
    expect(new Set([a, b, c2].map((id) => d.nodes[id].x)).size).toBe(1);
    expect(d.nodes[a].pinned).toBe(true);
    expect(d).toMatchObject({ direction: "LR", colorBy: "owner", edgeKinds: ["calls", "reads_writes"], titleBlock: { show: true, corner: "top-left" } });
    const box = Object.values(done.ws.objects).find((o) => o.typeId === "diagram" && o.diagramId === other.id)!;
    expect(d.nodes[box.id]).toBeTruthy();
    expect(d.flows?.[0]).toMatchObject({ name: "Checkout", steps: [{ fromId: a, toId: b, text: "Sends the order" }] });
    expect(done.problems).toEqual([]);
  });

  it("keeps to the person's rights: a kind of diagram they may not make is refused", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const done = applyOps(ws, diagram.id, [{ op: "set_diagram", viewType: "business" }], { ...who, mayUseView: (v) => v !== "business" });
    expect(done.ws.diagrams[diagram.id].viewType).toBe(diagram.viewType);
    expect(done.problems[0]).toMatch(/may not make diagrams of the kind "business"/);
  });

  it("deletes the diagram, its objects staying in the model, once a person said yes", () => {
    const ws = demoWorkspace("Khaled");
    const diagram = diagramNamed(ws, "Inside Online store");
    const done = applyOps(ws, diagram.id, [{ op: "delete_diagram" }], who);
    expect(done.ws.diagrams[diagram.id]).toBeUndefined();
    expect(Object.keys(done.ws.objects)).toHaveLength(Object.keys(ws.objects).length);
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
