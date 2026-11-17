import { describe, expect, it } from "vitest";
import { sampleLandscape } from "../bpm/templates";
import { saveComponent, saveProtocol } from "../libraryEdits";
import { setAiPolicy } from "../aiPolicy";
import { demoWorkspace } from "../demo";
import { createObject, createRelationship, deleteObject, emptyWorkspace, placeNodes, updateObject } from "../model";
import type { Workspace } from "../types";
import { BackendError } from "./backend";
import { fromRow, toRow } from "./rows";
import { newReportId, saveReport } from "../reports";
import { saveTemplate, templateFromDiagram } from "../templates";
import { BUILT_IN_STEPS, saveWizard } from "../wizard";
import { SyncEngine, type SyncState } from "./sync";
import { TABLE_NAMES, applyChangeSet, diffTables, emptyTables, fromTables, isEmptyChange, patchTables, sameValue, toTables, type ChangeSet, type Tables } from "./tables";

/** A server that keeps rows and tells every connected browser about each save, the saver included. */
class Server {
  tables: Tables = emptyTables();
  clients: Client[] = [];
  down = false;
  refuse: BackendError | null = null;
  pushes = 0;
  async push(change: ChangeSet) {
    await Promise.resolve();
    if (this.down) throw new BackendError("network", "offline");
    if (this.refuse) throw this.refuse;
    this.pushes++;
    this.tables = patchTables(this.tables, change);
    // Rows travel as JSON, so receivers get copies, with keys in the database's order.
    const wire = JSON.parse(JSON.stringify(change)) as ChangeSet;
    queueMicrotask(() => this.clients.forEach((c) => c.connected && c.engine.remote(wire)));
  }
}

class Client {
  ws: Workspace;
  past: Workspace[] = [];
  states: SyncState[] = [];
  engine: SyncEngine;
  connected = true;
  role: "editor" | "viewer" = "editor";
  constructor(server: Server) {
    this.ws = { ...emptyWorkspace(), ...fromTables(server.tables) };
    this.engine = new SyncEngine(
      {
        getWorkspace: () => this.ws,
        applyRemote: (change) => {
          this.ws = change(this.ws);
          this.past = this.past.map(change);
        },
        push: (change) => server.push(change),
        load: async () => server.tables,
        canEdit: () => this.role === "editor",
        onState: (s) => this.states.push(s),
        debounceMs: 0,
        retryMs: 5,
      },
      server.tables,
    );
    server.clients.push(this);
  }
  edit(change: (ws: Workspace) => Workspace) {
    this.past.push(this.ws);
    this.ws = change(this.ws);
    this.engine.localChanged();
  }
  undo() {
    this.ws = this.past.pop()!;
    this.engine.localChanged();
  }
}

const settle = async (ms = 30) => new Promise((r) => setTimeout(r, ms));
const same = (a: Workspace, b: Workspace) => sameValue(toTables(a), toTables(b));

describe("rows and tables", () => {
  it("splits a workspace into rows and puts it back together unchanged", () => {
    const ws = demoWorkspace("Sara");
    const tables = toTables(ws);
    expect(Object.keys(tables.nodes).length).toBe(Object.values(ws.diagrams).reduce((n, d) => n + Object.keys(d.nodes).length, 0));
    expect(sameValue(fromTables(tables).diagrams, ws.diagrams)).toBe(true);
    expect(isEmptyChange(diffTables(tables, toTables(ws)))).toBe(true);
  });

  it("survives the trip to database columns and back for every table", () => {
    const demo = demoWorkspace("Sara");
    const firstDiagram = Object.keys(demo.diagrams)[0];
    const branded = { ...demo, branding: { workspace: { id: "workspace" as const, appName: "Bank", logo: "", accent: "#0f766e", theme: "oasis", font: "", updatedAt: "2026-11-17T00:00:00.000Z" } } };
    const withReport = saveReport(branded, { id: newReportId(), name: "Owners", description: "", subject: "components", columns: ["name", "owner"], filters: [{ field: "owner", op: "is empty", value: "" }], groupBy: "type", sortBy: null, sortDesc: false, createdBy: "Sara", createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z" });
    const withLibrary0 = saveProtocol(saveComponent(withReport, { name: "Core ledger", sectionId: "applications", kind: "application", icon: "Landmark", profile: "application", aliases: "GL" }).ws, { name: "ISO 8583", port: "7001", transport: "TCP", group: "Payments", secure: false, use: "" }).ws;
    const withLibrary = setAiPolicy(withLibrary0, (p) => ({ ...p, who: "editors", perUser: { hour: 5, day: 20, tokensDay: 9000 } }));
    const tables = toTables(sampleLandscape(saveWizard(saveTemplate(withLibrary, templateFromDiagram(withLibrary, firstDiagram, { name: "Mine", perspective: "data", about: "" }, "Sara")!.template), "container", BUILT_IN_STEPS.container, "Sara")));
    for (const table of TABLE_NAMES) {
      const entries = Object.entries(tables[table]);
      expect(entries.length).toBeGreaterThan(table === "proposals" || table === "adrs" || table === "rules" ? -1 : 0);
      for (const [key, value] of entries) {
        const row = JSON.parse(JSON.stringify(toRow(table, "ws", key, value)));
        const back = fromRow(table, row);
        expect(back.key).toBe(key);
        expect(sameValue(back.value, value)).toBe(true);
        expect(fromRow(table, { ...row, deleted: true }).value).toBeNull();
      }
    }
  });

  it("reports only what changed, and deletions as null", () => {
    const a = demoWorkspace();
    const id = Object.keys(a.objects)[3];
    const renamed = updateObject(a, id, { name: "Renamed" });
    expect(diffTables(toTables(a), toTables(renamed))).toEqual({ objects: { [id]: renamed.objects[id] } });
    const removed = diffTables(toTables(a), toTables(deleteObject(a, id)));
    expect(removed.objects?.[id]).toBeNull();
    expect(Object.values(removed.relationships ?? {}).every((v) => v === null)).toBe(true);
  });

  it("drops references to rows another person deleted", () => {
    const base = demoWorkspace();
    const used = Object.values(base.relationships)[0];
    const after = applyChangeSet(base, { objects: { [used.targetId]: null } });
    expect(after.relationships[used.id]).toBeUndefined();
    expect(Object.values(after.diagrams).some((d) => used.targetId in d.nodes)).toBe(false);
    expect(Object.values(after.objects).some((o) => o.parentId === used.targetId)).toBe(false);
  });
});

describe("real-time editing (FR-27)", () => {
  it("carries one person's edits to the other, both ways", async () => {
    const server = new Server();
    const ana = new Client(server);
    const ben = new Client(server);
    ana.edit(() => ({ ...demoWorkspace("Ana"), name: ana.ws.name }));
    await settle();
    expect(Object.keys(ben.ws.objects).length).toBe(Object.keys(ana.ws.objects).length);
    expect(same(ana.ws, ben.ws)).toBe(true);

    const id = Object.keys(ben.ws.objects)[0];
    ben.edit((ws) => updateObject(ws, id, { owner: "Platform team" }));
    await settle();
    expect(ana.ws.objects[id].owner).toBe("Platform team");
    expect(ana.engine.dirty || ben.engine.dirty).toBe(false);
    expect(ana.engine.current.kind).toBe("saved");
  });

  it("does not save again when its own change comes back from the server", async () => {
    const server = new Server();
    const ana = new Client(server);
    new Client(server);
    ana.edit((ws) => createObject(ws, { typeId: "service", name: "Billing" }).ws);
    await settle();
    expect(server.pushes).toBe(1);
  });

  it("lets two people move different boxes on one diagram without losing either move", async () => {
    const server = new Server();
    const ana = new Client(server);
    ana.edit(() => demoWorkspace());
    await settle();
    const ben = new Client(server);
    const diagram = Object.values(ana.ws.diagrams)[0];
    const [first, second] = Object.keys(diagram.nodes);
    ana.edit((ws) => placeNodes(ws, diagram.id, { [first]: { x: 1111, y: 11, pinned: true } }));
    ben.edit((ws) => placeNodes(ws, diagram.id, { [second]: { x: 2222, y: 22, pinned: true } }));
    await settle();
    for (const client of [ana, ben]) {
      expect(client.ws.diagrams[diagram.id].nodes[first].x).toBe(1111);
      expect(client.ws.diagrams[diagram.id].nodes[second].x).toBe(2222);
    }
  });

  it("settles on one value when two people change the same field", async () => {
    const server = new Server();
    const ana = new Client(server);
    ana.edit(() => demoWorkspace());
    await settle();
    const ben = new Client(server);
    const id = Object.keys(ana.ws.objects)[0];
    ana.edit((ws) => updateObject(ws, id, { name: "From Ana" }));
    ben.edit((ws) => updateObject(ws, id, { name: "From Ben" }));
    await settle(60);
    expect(ana.ws.objects[id].name).toBe(ben.ws.objects[id].name);
    expect(server.tables.objects[id].name).toBe(ana.ws.objects[id].name);
  });

  it("cleans up when one person deletes an object the other just connected to", async () => {
    const server = new Server();
    const ana = new Client(server);
    ana.edit(() => demoWorkspace());
    await settle();
    const ben = new Client(server);
    const [a, b] = Object.keys(ana.ws.objects);
    ana.edit((ws) => deleteObject(ws, b));
    ben.edit((ws) => createRelationship(ws, { sourceId: a, targetId: b, kind: "depends_on" }).ws);
    await settle(80);
    expect(same(ana.ws, ben.ws)).toBe(true);
    expect(Object.values(server.tables.relationships).some((r) => r.targetId === b || r.sourceId === b)).toBe(false);
  });

  it("keeps undo from removing the other person's work", async () => {
    const server = new Server();
    const ana = new Client(server);
    ana.edit(() => demoWorkspace());
    await settle();
    const ben = new Client(server);
    const [mine, theirs] = Object.keys(ana.ws.objects);
    ana.edit((ws) => updateObject(ws, mine, { name: "Ana's edit" }));
    await settle();
    ben.edit((ws) => updateObject(ws, theirs, { name: "Ben's edit" }));
    await settle();
    ana.undo();
    await settle();
    expect(ana.ws.objects[mine].name).not.toBe("Ana's edit");
    expect(ana.ws.objects[theirs].name).toBe("Ben's edit");
    expect(server.tables.objects[theirs].name).toBe("Ben's edit");
  });

  it("keeps edits made while offline and saves them when the connection returns", async () => {
    const server = new Server();
    const ana = new Client(server);
    const ben = new Client(server);
    server.down = true;
    ana.edit((ws) => createObject(ws, { typeId: "database", name: "Ledger" }).ws);
    await settle();
    expect(ana.engine.current.kind).toBe("offline");
    expect(Object.keys(ben.ws.objects)).toHaveLength(0);
    server.down = false;
    await settle(80);
    expect(ana.engine.current.kind).toBe("saved");
    expect(Object.values(ben.ws.objects).map((o) => o.name)).toEqual(["Ledger"]);
  });

  it("catches up on changes missed while disconnected, keeping local edits", async () => {
    const server = new Server();
    const ana = new Client(server);
    const ben = new Client(server);
    ana.edit(() => demoWorkspace());
    await settle();
    const [one, two] = Object.keys(ana.ws.objects);
    ben.connected = false;
    server.down = true;
    ben.edit((ws) => updateObject(ws, two, { owner: "Ben offline" }));
    server.down = false;
    ana.edit((ws) => updateObject(ws, one, { owner: "Ana meanwhile" }));
    await settle();
    expect(ben.ws.objects[one].owner).not.toBe("Ana meanwhile");
    ben.connected = true;
    await ben.engine.resync();
    await settle(80);
    expect(ben.ws.objects[one].owner).toBe("Ana meanwhile");
    expect(ana.ws.objects[two].owner).toBe("Ben offline");
  });

  it("puts a viewer's attempted change back and saves nothing", async () => {
    const server = new Server();
    const ana = new Client(server);
    ana.edit(() => demoWorkspace());
    await settle();
    const vera = new Client(server);
    vera.role = "viewer";
    const id = Object.keys(vera.ws.objects)[0];
    const before = vera.ws.objects[id].name;
    const pushes = server.pushes;
    vera.edit((ws) => updateObject(ws, id, { name: "Not allowed" }));
    await settle();
    expect(vera.ws.objects[id].name).toBe(before);
    expect(server.pushes).toBe(pushes);
    expect(vera.engine.current.kind).toBe("readonly");
  });

  it("reverts when the server says the person lost edit access", async () => {
    const server = new Server();
    const ana = new Client(server);
    ana.edit(() => demoWorkspace());
    await settle();
    const id = Object.keys(ana.ws.objects)[0];
    const before = ana.ws.objects[id].name;
    server.refuse = new BackendError("forbidden", "no");
    ana.edit((ws) => updateObject(ws, id, { name: "Too late" }));
    await settle();
    expect(ana.ws.objects[id].name).toBe(before);
    expect(ana.engine.current.kind).toBe("readonly");
  });
});
